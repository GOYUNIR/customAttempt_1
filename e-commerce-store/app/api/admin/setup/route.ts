import { NextResponse } from 'next/server';
import { adminRequestAuthorized, getAdminPassword } from '@/lib/server-config';
import { isValidEmail } from '@/lib/validation';
import { isSuperAdminSession } from '@/lib/admin-verify';
import {
  getPlatformSettings,
  isPlatformConfigured,
  savePlatformSettings,
  saveOperationalSettings,
  normalizeOperationalSettingsInput,
  markPlatformConfigured,
  normalizePlatformSettingsInput,
} from '@/services/config/platform-settings';
import { toPublicSummary, hasOperationalSettings } from '@/services/config/types';
import { supabaseEnvSummary } from '@/services/config/edge';
import { createSuperAdmin, supabaseServiceConfigured, setSupabaseRuntimeCredentials } from '@/services/config/supabase-client';
import {
  discoverEnvironment,
  computeAdminReady,
  detectStorageDrivers,
  detectStorageProvider,
  CLOUDFLARE_VARS_PATH,
} from '@/lib/env-discovery';

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
  const platformProviders = toPublicSummary(settings);

  const storageDrivers = detectStorageDrivers();
  const legacyAdminOk = Boolean(getAdminPassword());
  const platformConfigured = configured === true;
  const ready = computeAdminReady({ storage: storageDrivers, legacyAdminOk, platformConfigured });
  const storageOk =
    storageDrivers.supabase || storageDrivers.cloudflare || storageDrivers.redis || platformConfigured;

  return NextResponse.json({
    configured: platformConfigured,
    ready,
    storageProvider: detectStorageProvider(),
    storageDrivers,
    storageOk,
    legacyAdminOk,
    platformConfigured,
    platformProviders,
    operationalConfigured: hasOperationalSettings(settings?.operational_settings),
    supabase: supabaseEnvSummary(),
    settings: platformProviders,
    environment: process.env.NODE_ENV || 'development',
    cloudflareVarsPath: CLOUDFLARE_VARS_PATH,
    discovery: discoverEnvironment(),
  });
}

export async function POST(request: Request) {
  // Tracks how far the bootstrap got before an error so the wizard can surface a
  // contextual alert pointing at the exact step (storage → admin → finalize).
  let stage: 'storage_init' | 'create_admin' | 'finalize' = 'storage_init';
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    // ── Supabase credentials (inline entry when the env is missing) ──────────
    // Operators can paste SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY directly.
    // If they aren't in the environment yet, use the submitted values for THIS
    // bootstrap and keep them as a runtime override so the readiness gate and
    // subsequent requests in this process can reach Supabase immediately.
    const supabaseUrl = String(body.supabaseUrl || body.supabase_url || '').trim().replace(/\/+$/, '');
    const supabaseAnonKey = String(body.supabaseAnonKey || body.supabase_anon_key || '').trim();
    const supabaseServiceRoleKey = String(body.supabaseServiceRoleKey || body.supabase_service_role_key || '').trim();

    if (supabaseServiceConfigured()) {
      setSupabaseRuntimeCredentials(null); // use the environment values
    } else if (supabaseUrl && supabaseAnonKey && supabaseServiceRoleKey) {
      if (!/^https?:\/\//i.test(supabaseUrl)) {
        return NextResponse.json(
          { error: 'Enter a valid Supabase project URL (starting with https://).' },
          { status: 400 },
        );
      }
      setSupabaseRuntimeCredentials({ url: supabaseUrl, anonKey: supabaseAnonKey, serviceRoleKey: supabaseServiceRoleKey });
    } else {
      return NextResponse.json(
        {
          error:
            'Enter SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY below, or set them in the platform environment.',
        },
        { status: 400 },
      );
    }

    // ── super-admin account (first setup only) ───────────────────────────────
    const adminEmail = String(body.adminEmail || '').trim().toLowerCase();
    const adminPassword = String(body.adminPassword || '');

    // ── provider keys ────────────────────────────────────────────────────────
    const normalized = normalizePlatformSettingsInput(body);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    // ── operational settings (security / site / payments / AI / storage) ─────
    const operational = normalizeOperationalSettingsInput(body);

    // ── re-configuration guard ───────────────────────────────────────────────
    const alreadyConfigured = (await isPlatformConfigured()) === true;
    const superAdminSession = await isSuperAdminSession(request);
    if (alreadyConfigured && !adminRequestAuthorized(request, adminPassword) && !superAdminSession) {
      return NextResponse.json(
        { error: 'The platform is already configured. Enter the admin password or sign in as the super-admin to update providers.' },
        { status: 403 },
      );
    }

    // First-run requires a valid master account; re-configuration keeps the
    // existing super-admin and never re-creates it (re-creating would 422 on
    // the duplicate email and silently fail the save).
    if (!alreadyConfigured) {
      if (!isValidEmail(adminEmail)) {
        return NextResponse.json({ error: 'Enter a valid super-admin email address.' }, { status: 400 });
      }
      if (adminPassword.length < 6 || adminPassword.length > 128) {
        return NextResponse.json({ error: 'Super-admin password must be 6–128 characters.' }, { status: 400 });
      }
    }

    // 1. Persist provider keys (is_configured stays false until the admin exists).
    stage = 'storage_init';
    await savePlatformSettings(normalized.input);

    // 2. Persist operational settings (security / site / payments / AI / storage).
    stage = 'storage_init';
    await saveOperationalSettings(operational);

    // 3. Create the master super-admin on first setup only.
    stage = 'create_admin';
    if (!alreadyConfigured) {
      await createSuperAdmin({ email: adminEmail, password: adminPassword });
    }

    // 4. Flip the gate — clears the settings cache so the runtime driver
    //    factories re-resolve against the newly persisted providers.
    stage = 'finalize';
    await markPlatformConfigured();

    return NextResponse.json({ ok: true, redirect: '/admin' });
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error('[setup] failed', message);
    return NextResponse.json(
      { success: false, error: message, stage },
      { status: 422 },
    );
  }
}
