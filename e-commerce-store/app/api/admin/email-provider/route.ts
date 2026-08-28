import { NextResponse } from 'next/server';
import { createRedisClient, adminRequestAuthorized } from '@/lib/server-config';
import {
  adminLoginAuthorized,
  isSuperAdminSession,
  isAdminDeviceValid,
  adminDeviceTokenFromRequest,
} from '@/lib/admin-verify';
import { getPlatformSettings, clearPlatformSettingsCache } from '@/services/config/platform-settings';
import { upsertPlatformSettingsRow } from '@/services/config/supabase-client';
import { GLOBAL_PLATFORM_SETTINGS_ROW_ID, sanitizeMailProvider } from '@/services/config/types';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/email-provider — the portal's dedicated email-provider settings.
 *
 * Configuring a provider here activates the 6-digit two-step sign-in gate for
 * every FUTURE login (see /api/admin/login). Until one is configured, the login
 * controller grants dashboard access on the correct password alone. Only the
 * provider NAME is ever returned — the API key is written to
 * `global_platform_settings` and never echoed back.
 */

async function authorized(request: Request, password: string): Promise<boolean> {
  if (adminRequestAuthorized(request, password)) return true;
  if (await adminLoginAuthorized(request, password)) return true;
  if (await isSuperAdminSession(request)) return true;
  // A normal verified device cookie (issued after the 2FA code) is also a valid
  // admin session — the middleware has already validated it, this is defense in
  // depth so the route can never be reached by an unauthenticated caller.
  const redis = createRedisClient();
  const token = adminDeviceTokenFromRequest(request);
  if (redis && token) {
    return await isAdminDeviceValid(redis, token).catch(() => false);
  }
  return false;
}

export async function GET() {
  const settings = await getPlatformSettings({ force: true }).catch(() => null);
  return NextResponse.json({ ok: true, provider: settings?.mail_provider || '' });
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const password = String(body?.password || '');
  if (!(await authorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const provider = sanitizeMailProvider(body?.provider);
  const apiKey = String(body?.apiKey || '').trim();

  if (provider && !apiKey) {
    return NextResponse.json({ error: 'Enter the API key for the selected email provider.' }, { status: 400 });
  }

  await upsertPlatformSettingsRow({
    id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
    mail_provider: provider || null,
    mail_api_key: provider ? apiKey : null,
  });
  clearPlatformSettingsCache();

  return NextResponse.json({ ok: true, provider: provider || '' });
}
