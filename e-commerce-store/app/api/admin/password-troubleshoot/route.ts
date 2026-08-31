import { NextResponse } from 'next/server';
import { adminAuthorized } from '@/lib/admin-verify';
import {
  getAdminPassword,
  verifyAdminPassword,
  getAdminVerifyEmail,
} from '@/lib/server-config';
import { isPlatformConfigured, getPlatformSettings } from '@/services/config/platform-settings';
import { supabaseServiceConfigured, supabaseAuthConfigured } from '@/services/config/supabase-client';
import { appendAudit } from '@/app/api/admin/audit/route';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * SECURE ADMIN PASSWORD TROUBLESHOOTING TOOL.
 *
 * Only reachable by an operator who can already pass full admin authorization
 * (Basic-Auth password, a verified device cookie, or a super-admin session).
 * It NEVER returns a secret — only presence booleans and masked identities —
 * and every access is appended to the admin audit log so a live-streamed or
 * compromised session leaves a trace.
 */
export async function POST(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const password = String(body?.password || '');

  // Defense-in-depth: require FULL admin authorization (not just the middleware
  // gate). The operator must re-supply the admin password OR hold a verified
  // device / super-admin session.
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Re-authentication required.' }, { status: 403 });
  }

  const redis = createRedisClient();
  const adminPasswordSet = Boolean(getAdminPassword());
  const verifyEmail = getAdminVerifyEmail();
  const configured = (await isPlatformConfigured()) === true;
  const settings = await getPlatformSettings();
  const report = {
    // Presence booleans only — never the secret itself.
    adminBasicAuthPasswordSet: adminPasswordSet,
    // The basic-auth "username" is the admin email (masked for safety).
    adminBasicAuthUsername: maskIdentity(verifyEmail),
    // Two-step verification inbox.
    adminVerifyEmail: maskIdentity(verifyEmail),
    adminVerifyEmailSet: Boolean(verifyEmail),
    // Whether a Supabase master account exists (password grant login path).
    supabaseAuthConfigured: supabaseAuthConfigured(),
    supabaseServiceConfigured: supabaseServiceConfigured(),
    platformConfigured: configured,
    mailProviderConfigured: Boolean(settings?.mail_provider && settings?.mail_api_key),
    // The verified password was accepted (proof the operator passed re-auth).
    reauthVerified: Boolean(password) ? verifyAdminPassword(password) : true,
  };

  // Log every access for the security record.
  if (redis) {
    await appendAudit(redis, {
      action: 'admin_password_troubleshoot',
      detail: `Password diagnostic viewed (basic-auth ${adminPasswordSet ? 'set' : 'unset'}, verify-email ${verifyEmail ? 'set' : 'unset'}, platform ${configured ? 'configured' : 'not configured'})`,
      actor: 'admin',
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true, report });
}

function maskIdentity(value: string): string {
  const v = String(value || '').trim();
  if (!v) return '';
  if (!v.includes('@')) return v.slice(0, 2) + '•••';
  const [local, domain] = v.split('@');
  return `${local.slice(0, 2)}•••@${domain}`;
}
