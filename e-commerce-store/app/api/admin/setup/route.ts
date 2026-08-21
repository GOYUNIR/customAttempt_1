import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isValidEmail } from '@/lib/validation';
import { isSuperAdminSession } from '@/lib/admin-verify';
import {
  getPlatformSettings,
  isPlatformConfigured,
  savePlatformSettings,
  markPlatformConfigured,
  normalizePlatformSettingsInput,
} from '@/services/config/platform-settings';
import { toPublicSummary } from '@/services/config/types';
import { supabaseEnvSummary } from '@/services/config/edge';
import { createSuperAdmin, supabaseServiceConfigured } from '@/services/config/supabase-client';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/setup — the Setup Wizard backend.
 *
 * GET:  current configuration status (provider NAMES only — never key values)
 *       plus whether the Supabase env vars are present. Used by the wizard page
 *       to prefill + warn.
 *
 * POST: persists the provider keys to `global_platform_settings`, creates the
 *       master super-admin (Supabase Auth user flagged is_super_admin), then
 *       flips is_configured = true. The middleware's setup gate opens BEFORE
 *       Basic Auth exists, so the FIRST save needs no credentials; a RE-save on
 *       an already-configured platform requires the admin password.
 */
export async function GET() {
  const settings = await getPlatformSettings({ force: true });
  const configured = await isPlatformConfigured({ force: true });
  return NextResponse.json({
    configured: configured === true,
    supabase: supabaseEnvSummary(),
    settings: toPublicSummary(settings),
  });
}

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    if (!supabaseServiceConfigured()) {
      return NextResponse.json(
        {
          error:
            'SUPABASE_SERVICE_ROLE_KEY is not set. Add SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY to the platform environment, then run the Setup Wizard.',
        },
        { status: 500 },
      );
    }

    // ── super-admin account ──────────────────────────────────────────────────
    const adminEmail = String(body.adminEmail || '').trim().toLowerCase();
    const adminPassword = String(body.adminPassword || '');
    if (!isValidEmail(adminEmail)) {
      return NextResponse.json({ error: 'Enter a valid super-admin email address.' }, { status: 400 });
    }
    if (adminPassword.length < 6 || adminPassword.length > 128) {
      return NextResponse.json({ error: 'Super-admin password must be 6–128 characters.' }, { status: 400 });
    }

    // ── provider keys ────────────────────────────────────────────────────────
    const normalized = normalizePlatformSettingsInput(body);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    // ── re-configuration guard ───────────────────────────────────────────────
    const alreadyConfigured = (await isPlatformConfigured()) === true;
    const superAdminSession = await isSuperAdminSession(request);
    if (alreadyConfigured && !adminRequestAuthorized(request, adminPassword) && !superAdminSession) {
      return NextResponse.json(
        { error: 'The platform is already configured. Enter the admin password or sign in as the super-admin to update providers.' },
        { status: 403 },
      );
    }

    // 1. Persist provider keys (is_configured stays false until the admin exists).
    await savePlatformSettings(normalized.input);

    // 2. Create the master super-admin (service role).
    await createSuperAdmin({ email: adminEmail, password: adminPassword });

    // 3. Flip the gate.
    await markPlatformConfigured();

    return NextResponse.json({ ok: true, redirect: '/admin' });
  } catch (err: any) {
    console.error('[setup] failed', err?.message || err);
    return NextResponse.json(
      { error: 'Setup could not be completed. Check the server logs for details.' },
      { status: 500 },
    );
  }
}
