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
import { createSuperAdmin, supabaseServiceConfiguredFromEnv, setSupabaseRuntimeCredentials, verifyServiceRoleAccess, probePlatformSettingsSchema } from '@/services/config/supabase-client';
import {
  discoverEnvironment,
  computeAdminReady,
  detectStorageDrivers,
  detectStorageProvider,
  CLOUDFLARE_VARS_PATH,
} from '@/lib/env-discovery';
import { isSchemaError, buildSchemaFixPlan, schemaFixPlanToText } from '@/lib/setup-schema-guide';

export const dynamic = 'force-dynamic';

// Supabase schema-not-applied detection + the step-by-step fix live in the
// shared `@/lib/setup-schema-guide` module (used by both this route and the
// wizard page, so the two can never drift).

/** Quick Upstash REST reachability check (GET /ping → PONG). */
async function pingUpstash(url: string, token: string): Promise<void> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/ping`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstash data store is unreachable (${res.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * Step-1 (data store) probe: verifies the Supabase schema + service-role
 * reachability (and the chosen storefront data store), then persists the
 * storage-related operational settings so the operator's data-store choices are
 * saved early. Never creates the admin or flips is_configured.
 */
async function probeStorage(operational: ReturnType<typeof normalizeOperationalSettingsInput>) {
  try {
    await probePlatformSettingsSchema();
    const storageProvider = String(operational.storage_provider || 'supabase').toLowerCase();
    if (storageProvider === 'upstash' || storageProvider === 'redis') {
      const url = String(operational.upstash_redis_rest_url || '').trim();
      const token = String(operational.upstash_redis_rest_token || '').trim();
      if (!url || !token) {
        throw new Error('Upstash REST URL and token are required for the selected data store.');
      }
      await pingUpstash(url, token);
    }
    await saveOperationalSettings(operational);
    return NextResponse.json({ ok: true, probed: 'storage' });
  } catch (err: unknown) {
    const message = (err as Error)?.message || String(err);
    console.error('[setup] storage probe failed', message);
    const schemaMissing = isSchemaError(message);
    const plan = schemaMissing ? buildSchemaFixPlan(message) : null;
    return NextResponse.json(
      {
        success: false,
        error: plan ? schemaFixPlanToText(plan) : message,
        stage: 'storage_init',
        schemaMissing,
        schemaError: plan,
      },
      { status: 422 },
    );
  }
}

/** Fetch with an 8s timeout; throws a descriptive error instead of a raw one. */
async function probeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(`Could not reach ${new URL(url).host} — check your network connection.`);
  }
}

/** Verify the ACTIVE payment provider key against its real API. */
async function verifyPaymentProvider(provider: string, key: string): Promise<void> {
  const p = String(provider || '').toLowerCase();
  if (!p || p === 'none') return;
  if (!key) throw new Error('Payment API key is required (or choose "Skip payments for now").');
  let url = '';
  let headers: Record<string, string> = {};
  if (p === 'stripe') {
    url = 'https://api.stripe.com/v1/balance';
    headers = { Authorization: `Bearer ${key}` };
  } else if (p === 'lemon_squeezy') {
    url = 'https://api.lemonsqueezy.com/v1/stores';
    headers = { Authorization: `Bearer ${key}` };
  } else if (p === 'paddle') {
    url = 'https://api.paddle.com/customers';
    headers = { Authorization: `Bearer ${key}`, 'Paddle-Version': '1' };
  } else {
    return;
  }
  const res = await probeFetch(url, { headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Payment provider rejected the key (HTTP ${res.status}). Check the API key.`);
  }
  if (!res.ok) throw new Error(`Payment provider is unreachable (HTTP ${res.status}).`);
}

/** Verify the ACTIVE email provider key against its real API. */
async function verifyEmailProvider(provider: string, key: string): Promise<void> {
  const p = String(provider || '').toLowerCase();
  if (!p) return;
  if (!key) throw new Error('Email API key is required.');
  let url = '';
  let headers: Record<string, string> = {};
  if (p === 'resend') {
    url = 'https://api.resend.com/domains';
    headers = { Authorization: `Bearer ${key}` };
  } else if (p === 'postmark') {
    url = 'https://api.postmarkapp.com/server';
    headers = { 'X-Postmark-Server-Token': key };
  } else if (p === 'sendgrid') {
    url = 'https://api.sendgrid.com/v3/scopes';
    headers = { Authorization: `Bearer ${key}` };
  } else {
    return;
  }
  const res = await probeFetch(url, { headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Email provider rejected the key (HTTP ${res.status}). Check the API key.`);
  }
  if (!res.ok) throw new Error(`Email provider is unreachable (HTTP ${res.status}).`);
}

/** Maps tokens are public browser keys — verify their format (not billable calls). */
function verifyMapsToken(provider: string, key: string): void {
  const p = String(provider || '').toLowerCase();
  if (!p || p === 'open_street_map' || p === 'none') return;
  if (!key) throw new Error('Maps key is required (or choose the keyless OpenStreetMap provider).');
  if (p === 'mapbox' && !/^pk\./i.test(key)) {
    throw new Error('Mapbox token must start with "pk." — paste the PUBLIC access token, not the secret key.');
  }
  if (p === 'google_maps' && !/^AIza/i.test(key)) {
    throw new Error('Google Maps key should start with "AIza…" — check Google Cloud Console.');
  }
}

/** Verify the ACTIVE AI provider key against its real API. */
async function verifyAiProvider(provider: string, key: string): Promise<void> {
  const p = String(provider || '').toLowerCase();
  if (!p || p === 'none' || p === 'workers_ai') return;
  if (!key) throw new Error('AI API key is required (Workers AI needs none).');
  let url = '';
  let headers: Record<string, string> = {};
  switch (p) {
    case 'deepseek':
    case 'deepseek_lite':
      url = 'https://api.deepseek.com/user/balance';
      headers = { Authorization: `Bearer ${key}` };
      break;
    case 'openai':
      url = 'https://api.openai.com/v1/models';
      headers = { Authorization: `Bearer ${key}` };
      break;
    case 'anthropic':
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      break;
    case 'replicate':
      url = 'https://api.replicate.com/v1/account';
      headers = { Authorization: `Bearer ${key}` };
      break;
    case 'openrouter':
      url = 'https://openrouter.ai/api/v1/models';
      headers = { Authorization: `Bearer ${key}` };
      break;
    case 'groq':
      url = 'https://api.groq.com/openai/v1/models';
      headers = { Authorization: `Bearer ${key}` };
      break;
    case 'mistral':
      url = 'https://api.mistral.ai/v1/models';
      headers = { Authorization: `Bearer ${key}` };
      break;
    case 'google_gemini':
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      break;
    default:
      return;
  }
  const res = await probeFetch(url, { headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`AI provider rejected the key (HTTP ${res.status}). Check the API key.`);
  }
  if (!res.ok) throw new Error(`AI provider is unreachable (HTTP ${res.status}).`);
}

/** Continue on the "Core services" step — verify payment/email/maps live. */
async function probeCore(body: Record<string, unknown>): Promise<NextResponse> {
  try {
    await verifyPaymentProvider(String(body.payment_provider || ''), String(body.payment_api_key || '').trim());
    await verifyEmailProvider(String(body.mail_provider || ''), String(body.mail_api_key || '').trim());
    verifyMapsToken(String(body.map_provider || ''), String(body.map_api_key || '').trim());
    return NextResponse.json({ ok: true, probed: 'core' });
  } catch (err: unknown) {
    const message = (err as Error)?.message || String(err);
    console.error('[setup] core services probe failed', message);
    return NextResponse.json({ success: false, error: message, stage: 'core_services' }, { status: 422 });
  }
}

/** Continue on the "AI engine" step — verify the primary (and secondary) key live. */
async function probeAi(body: Record<string, unknown>): Promise<NextResponse> {
  try {
    const primary = String(body.ai_provider || '').toLowerCase();
    await verifyAiProvider(primary, String(body.ai_api_key || '').trim());
    const secondary = String(body.ai_provider_secondary || '').toLowerCase();
    const isDeepSeek = (p: string) => p === 'deepseek' || p === 'deepseek_lite';
    if (secondary && secondary !== 'none' && secondary !== 'workers_ai') {
      // DeepSeek Pro + Lite share ONE key — a DeepSeek secondary reuses the primary.
      const reusesPrimary = isDeepSeek(secondary) && isDeepSeek(primary) && Boolean(String(body.ai_api_key || '').trim());
      if (!reusesPrimary) {
        await verifyAiProvider(secondary, String(body.ai_api_key_secondary || '').trim());
      }
    }
    return NextResponse.json({ ok: true, probed: 'ai' });
  } catch (err: unknown) {
    const message = (err as Error)?.message || String(err);
    console.error('[setup] ai probe failed', message);
    return NextResponse.json({ success: false, error: message, stage: 'ai' }, { status: 422 });
  }
}

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
export async function GET(request: Request) {
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

  // ── reconfigure status (no secret exposure to unauthenticated callers) ──────
  // Once the platform is configured, the reconfigure wizard still needs to know
  // `configured`/`ready` so it can render the "sign in as super-admin" panel —
  // but an unauthenticated caller must NOT receive the full provider/env
  // snapshot (presence booleans, provider names, schema error text). Return the
  // minimal safe status for unauthenticated requests; the full payload is only
  // served to a caller with Basic Auth or a super-admin session.
  if (platformConfigured) {
    const authorized = adminRequestAuthorized(request) || (await isSuperAdminSession(request));
    if (!authorized) {
      return NextResponse.json({ configured: true, ready: true, signedIn: false });
    }
  }

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

    // ── operational settings (security / site / payments / AI / storage) ─────
    const operational = normalizeOperationalSettingsInput(body);

    // ── data-store probe (Continue on step 1) ───────────────────────────────
    // Verifying the data store the moment the operator leaves the data-store
    // step surfaces a missing schema / unreachable backend right there, instead
    // of only after every other step has been filled in and the final save runs.
    if (String(body.probe || '').trim() === 'storage') {
      return probeStorage(operational);
    }

    // ── core-services probe (Continue on step 3) ───────────────────────────
    // Verify the payment / email / maps keys against their real APIs BEFORE the
    // operator advances, so a wrong Stripe/Resend key is caught immediately.
    if (String(body.probe || '').trim() === 'core') {
      return probeCore(body);
    }

    // ── AI probe (Continue on step 5) ──────────────────────────────────────
    if (String(body.probe || '').trim() === 'ai') {
      return probeAi(body);
    }

    // ── super-admin account (first setup only) ───────────────────────────────
    const adminEmail = String(body.adminEmail || '').trim().toLowerCase();
    const adminPassword = String(body.adminPassword || '');

    // ── provider keys ────────────────────────────────────────────────────────
    const normalized = normalizePlatformSettingsInput(body);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    // ── re-configuration guard ───────────────────────────────────────────────
    const alreadyConfigured = (await isPlatformConfigured()) === true;
    const superAdminSession = await isSuperAdminSession(request);
    // Accept EITHER the master admin password (step 2) or the dedicated
    // ADMIN_BASIC_AUTH_PASSWORD field (step 4) as the supplied Basic-Auth secret.
    const basicAuthOk = adminRequestAuthorized(
      request,
      String(body.admin_basic_auth_password || adminPassword),
    );

    // Beyond the Basic-Auth password and a valid super-admin device session, the
    // Supabase SERVICE-ROLE key is accepted as authorization: it is the master
    // write credential for `global_platform_settings`, so proving it (a successful
    // authenticated read) is equivalent to super-admin. This unblocks the deadlock
    // where the platform is already configured but the Supabase env was never set
    // (inline wizard credentials are volatile and lost on a cold start) — the
    // operator can re-enter their credentials and save again instead of being met
    // with a 403 they can't resolve.
    let serviceRoleAuthorized = false;
    if (alreadyConfigured && !basicAuthOk && !superAdminSession) {
      serviceRoleAuthorized = await verifyServiceRoleAccess();
    }

    if (alreadyConfigured && !basicAuthOk && !superAdminSession && !serviceRoleAuthorized) {
      return NextResponse.json(
        {
          error:
            'This store is already configured. To update it, authenticate first: sign in as the master admin above, or set ADMIN_BASIC_AUTH_PASSWORD and use Basic Auth, or set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY as environment variables on your host (Cloudflare: npx wrangler secret put …) so the service-role key can authorize the save.',
        },
        { status: 403 },
      );
    }

    // First-run requires a valid master account; re-configuration keeps the
    // existing super-admin and never re-creates it (re-creating would 422 on
    // the duplicate email and silently fail the save).
    if (!alreadyConfigured) {
      if (!isValidEmail(adminEmail)) {
        return NextResponse.json({ error: 'Enter a valid admin email address.' }, { status: 400 });
      }
      if (adminPassword.length < 6 || adminPassword.length > 128) {
        return NextResponse.json({ error: 'Admin password must be 6–128 characters.' }, { status: 400 });
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
    const response = NextResponse.json({
      ok: true,
      redirect: '/admin',
      // When Supabase credentials were entered inline (not present in the env),
      // they only survive the current server session. Surface this so the
      // operator knows to persist them as environment variables — otherwise they
      // will be locked out of the admin portal again on the next restart/deploy.
      warning: supabaseServiceConfiguredFromEnv()
        ? undefined
        : 'Supabase credentials were entered inline and are NOT saved as environment variables. They only work for the current server session. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in your hosting platform (and redeploy) — otherwise you will be locked out of the admin portal on the next restart or deploy.',
    });
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
    // applied (PostgREST "Could not find the table/column … in the schema
    // cache"). Translate it into a plain-English, numbered next step instead of
    // a raw PGRST error.
    const schemaMissing = isSchemaError(message);
    const plan = schemaMissing ? buildSchemaFixPlan(message) : null;
    return NextResponse.json(
      { success: false, error: plan ? schemaFixPlanToText(plan) : message, stage, schemaMissing, schemaError: plan },
      { status: 422 },
    );
  }
}
