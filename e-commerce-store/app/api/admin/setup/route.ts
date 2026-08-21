import { NextResponse } from 'next/server';
import { adminRequestAuthorized, getAdminPassword, createRedisClient, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { isValidEmail } from '@/lib/validation';
import { isSuperAdminSession, issueAdminDevice } from '@/lib/admin-verify';
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
import { createSuperAdmin, supabaseServiceConfiguredFromEnv, setSupabaseRuntimeCredentials } from '@/services/config/supabase-client';
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
  let settings: Awaited<ReturnType<typeof getPlatformSettings>> = null;
  let configured: Awaited<ReturnType<typeof isPlatformConfigured>> = null;
  let supabaseSchemaError = '';

  // A missing Supabase schema (tables never applied) must not 500 the status
  // endpoint — capture the failure and surface it so the wizard can warn the
  // operator BEFORE they save instead of only after the POST blows up.
  try {
    settings = await getPlatformSettings({ force: true });
  } catch (err: unknown) {
    supabaseSchemaError = (err as Error)?.message || String(err);
  }
  try {
    configured = await isPlatformConfigured({ force: true });
  } catch (err: unknown) {
    if (!supabaseSchemaError) supabaseSchemaError = (err as Error)?.message || String(err);
    configured = false;
  }

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
    supabaseSchemaError,
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

    if (supabaseServiceConfiguredFromEnv()) {
      setSupabaseRuntimeCredentials(null); // the environment can take over — drop any override
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

    // 5. On FIRST setup, sign the operator in as the super-admin immediately so
    //    the "Open admin portal →" click lands IN the portal instead of on the
    //    Basic-Auth + email-2FA gates. The device cookie carries `superAdmin:
    //    true`, which middleware.ts treats as full authorization. Best-effort:
    //    if no storage backend is reachable the operator can still super-login.
    const response = NextResponse.json({ ok: true, redirect: '/admin' });
    if (!alreadyConfigured) {
      const redis = createRedisClient();
      if (redis) {
        try {
          const { token, maxAgeSeconds } = await issueAdminDevice(redis, adminEmail, true, { superAdmin: true });
          response.cookies.set(ADMIN_DEVICE_COOKIE, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: maxAgeSeconds,
            path: '/',
          });
        } catch {
          // Non-fatal — the operator can still reach /admin/setup?reconfigure=1 and sign in.
        }
      }
    }
    return response;
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error('[setup] failed', message);
    // The most common Supabase bootstrap failure is a schema that was never
    // applied (PostgREST 404 "Could not find the table … in the schema cache").
    // Translate it into an actionable next step instead of a raw PGRST error.
    const schemaMissing = /could not find the table|schema cache|PGRST205|does not exist/i.test(message);
    const hint = schemaMissing
      ? ' — The Supabase schema is missing: run `supabase db push`, or paste supabase/migrations/00001_init.sql + 00002_setup_operational.sql into the Supabase SQL editor, then save again.'
      : '';
    return NextResponse.json(
      { success: false, error: message + hint, stage, schemaMissing },
      { status: 422 },
    );
  }
}
