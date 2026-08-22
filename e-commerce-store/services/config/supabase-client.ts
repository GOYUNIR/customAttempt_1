/**
 * SERVICES / CONFIG — Supabase REST client (fetch only, zero SDK).
 *
 * The whole driver engine reads/writes `public.global_platform_settings`
 * through plain `fetch` against PostgREST / GoTrue. Edge-safe: this module
 * imports nothing but `process.env` and global `fetch`, so it is usable from
 * `middleware.ts` (Edge runtime on Vercel AND Cloudflare Workers via OpenNext).
 *
 * Env vars:
 *   SUPABASE_URL                  — required (the project URL)
 *   SUPABASE_ANON_KEY             — required for the public `is_platform_configured` RPC
 *   SUPABASE_SERVICE_ROLE_KEY     — server-only; the trusted writer that
 *                                   upserts settings + creates the super-admin.
 * Aliases: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.
 */

import { GLOBAL_PLATFORM_SETTINGS_ROW_ID } from './types.ts';

export const SUPABASE_ENV_URL = 'SUPABASE_URL';
export const SUPABASE_ENV_ANON_KEY = 'SUPABASE_ANON_KEY';
export const SUPABASE_ENV_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

/**
 * Runtime credential override — set by the Setup Wizard when the operator pastes
 * Supabase credentials INLINE (they aren't in process.env yet). Persists for the
 * process lifetime so the bootstrap + the readiness gate can reach Supabase
 * immediately after a wizard save. Cleared with setSupabaseRuntimeCredentials(null).
 */
interface SupabaseRuntimeCredentials {
  url?: string;
  anonKey?: string;
  serviceRoleKey?: string;
}

/**
 * The runtime override is stored on `globalThis` (NOT a module-level `let`)
 * because `supabase-client` is imported with BOTH `./supabase-client` and
 * `./supabase-client.ts` specifiers across the app (route handlers use the
 * `@/` alias without `.ts`, while the `node --test`-loadable services use the
 * `.ts` form). A module-scoped variable can therefore be split into two
 * instances by the bundler and the override set in one place would be invisible
 * in the other. `globalThis` is a single shared namespace within a process, so
 * the override is always seen by every consumer.
 */
const RUNTIME_CREDENTIALS_GLOBAL = '__goyunir_supabase_runtime_credentials__';

function readRuntimeCredentials(): SupabaseRuntimeCredentials | null {
  const g = globalThis as Record<string, unknown>;
  const v = g[RUNTIME_CREDENTIALS_GLOBAL];
  return v && typeof v === 'object' ? (v as SupabaseRuntimeCredentials) : null;
}

function writeRuntimeCredentials(creds: SupabaseRuntimeCredentials | null): void {
  const g = globalThis as Record<string, unknown>;
  if (!creds) {
    delete g[RUNTIME_CREDENTIALS_GLOBAL];
    return;
  }
  g[RUNTIME_CREDENTIALS_GLOBAL] = {
    url: (creds.url || '').trim().replace(/\/+$/, ''),
    anonKey: (creds.anonKey || '').trim(),
    serviceRoleKey: (creds.serviceRoleKey || '').trim(),
  };
}

/** Set (or clear) the inline Supabase credentials the Setup Wizard entered. */
export function setSupabaseRuntimeCredentials(creds: SupabaseRuntimeCredentials | null): void {
  writeRuntimeCredentials(creds);
}

export function readSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } {
  const override = readRuntimeCredentials();
  const url = (override?.url || process.env[SUPABASE_ENV_URL] || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = (override?.anonKey || process.env[SUPABASE_ENV_ANON_KEY] || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  const serviceRoleKey = (override?.serviceRoleKey || process.env[SUPABASE_ENV_SERVICE_ROLE_KEY] || '').trim();
  return { url, anonKey, serviceRoleKey };
}

export function supabaseConfigured(): boolean {
  const { url, anonKey } = readSupabaseEnv();
  return Boolean(url && anonKey);
}

export function supabaseServiceConfigured(): boolean {
  const { url, serviceRoleKey } = readSupabaseEnv();
  return Boolean(url && serviceRoleKey);
}

/**
 * Whether the service-role credentials are present IN THE ENVIRONMENT (ignoring
 * the runtime override). The Setup Wizard uses this to decide whether to clear
 * a runtime override — the override must only be cleared when the environment
 * itself can take over, otherwise a warm-process re-save would drop the only
 * copy of the service-role key and fail with "SUPABASE_SERVICE_ROLE_KEY is not
 * configured".
 */
export function supabaseServiceConfiguredFromEnv(): boolean {
  const url = (process.env[SUPABASE_ENV_URL] || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceRoleKey = (process.env[SUPABASE_ENV_SERVICE_ROLE_KEY] || '').trim();
  return Boolean(url && serviceRoleKey);
}

function headers(key: string, extra?: Record<string, string>, bearer?: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${bearer || key}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

/** Generic PostgREST fetch. Throws a descriptive Error on non-2xx. */
export async function supabaseRestFetch(
  path: string,
  options: {
    key: string;
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    prefer?: string;
    /** Optional user access token — used for USER-SCOPED queries (RLS) where the
     *  Authorization header must carry the signed-in user's JWT instead of the
     *  anon/service key. The `apikey` header still carries `options.key`. */
    bearer?: string;
  },
): Promise<unknown> {
  const { url } = readSupabaseEnv();
  if (!url || !options.key) throw new Error('Supabase is not configured (SUPABASE_URL / key missing).');
  const prefer = options.prefer || (options.method === 'POST' ? 'return=representation' : undefined);
  const res = await fetch(`${url}/rest/v1${path}`, {
    method: options.method || 'GET',
    headers: headers(options.key, prefer ? { Prefer: prefer } : undefined, options.bearer),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** GoTrue (auth) fetch — used to create / verify the master super-admin. */
export async function supabaseAuthFetch(
  path: string,
  options: { key: string; method?: 'POST' | 'GET'; body?: unknown },
): Promise<unknown> {
  const { url } = readSupabaseEnv();
  if (!url || !options.key) throw new Error('Supabase is not configured (SUPABASE_URL / key missing).');
  const res = await fetch(`${url}/auth/v1${path}`, {
    method: options.method || 'GET',
    headers: headers(options.key),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase auth ${options.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * THE public configuration gate. Returns true / false / null (null when
 * Supabase env is missing or the RPC is unreachable — callers fail open).
 */
export async function fetchIsPlatformConfigured(): Promise<boolean | null> {
  if (!supabaseConfigured()) return null;
  const { anonKey } = readSupabaseEnv();
  try {
    const value = await supabaseRestFetch('/rpc/is_platform_configured', { key: anonKey });
    return value === true;
  } catch {
    return null;
  }
}

/** Service-role read of the single global settings row (null when absent). */
export async function fetchPlatformSettingsRow(): Promise<Record<string, unknown> | null> {
  if (!supabaseServiceConfigured()) return null;
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch(
    `/global_platform_settings?id=eq.${GLOBAL_PLATFORM_SETTINGS_ROW_ID}&limit=1`,
    { key: serviceRoleKey },
  )) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

/**
 * Verify the CURRENT service-role credential can actually reach the project and
 * read `global_platform_settings` — proof the caller holds the Supabase master
 * key. This is equivalent to super-admin authorization for the Setup Wizard's
 * reconfiguration guard: the service-role key is exactly what lets you write
 * `global_platform_settings` directly, so accepting it cannot be a privilege
 * escalation. It unblocks the deadlock where the platform is already configured
 * but the Supabase env was never set (inline wizard credentials are volatile and
 * lost on a cold start) — the operator can re-enter their credentials and save
 * again without a pre-existing session. Returns true only on a successful
 * authenticated read (a 401/403/network failure → false).
 */
export async function verifyServiceRoleAccess(): Promise<boolean> {
  if (!supabaseServiceConfigured()) return false;
  const { serviceRoleKey } = readSupabaseEnv();
  try {
    await supabaseRestFetch(
      `/global_platform_settings?id=eq.${GLOBAL_PLATFORM_SETTINGS_ROW_ID}&select=id&limit=1`,
      { key: serviceRoleKey },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only verification that the `global_platform_settings` schema is FULLY
 * applied — the table AND every column the wizard writes. A missing table throws
 * PostgREST `PGRST205`; a missing column (e.g. `ai_api_key_secondary` when
 * `00004_ai_secondary.sql` was never applied) throws `PGRST204`. This lets the
 * Setup Wizard surface the exact migration gap on the data-store step BEFORE the
 * final save, instead of after the operator fills every other step.
 */
export async function probePlatformSettingsSchema(): Promise<void> {
  if (!supabaseServiceConfigured()) {
    throw new Error('Supabase service role key is not configured — enter your Supabase Project URL, anon key and service role key.');
  }
  const { serviceRoleKey } = readSupabaseEnv();
  await supabaseRestFetch(
    `/global_platform_settings?select=id,is_configured,mail_provider,mail_api_key,payment_provider,payment_api_key,payment_webhook_secret,map_provider,map_api_key,ai_provider,ai_api_key,ai_provider_secondary,ai_api_key_secondary,operational_settings&limit=1`,
    { key: serviceRoleKey },
  );
}

/** Service-role upsert of the settings row (merge-duplicates on the fixed id). */
export async function upsertPlatformSettingsRow(row: Record<string, unknown>): Promise<void> {
  if (!supabaseServiceConfigured()) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured — cannot persist platform settings.');
  }
  const { serviceRoleKey } = readSupabaseEnv();
  await supabaseRestFetch('/global_platform_settings', {
    key: serviceRoleKey,
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
}

/**
 * Service-role creation of the master super-admin (Auth user + is_super_admin
 * profile flag so the RLS policy on global_platform_settings unlocks).
 */
export async function createSuperAdmin(input: {
  email: string;
  password: string;
}): Promise<{ id: string; email: string }> {
  if (!supabaseServiceConfigured()) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured — cannot create the super-admin.');
  }
  const { serviceRoleKey } = readSupabaseEnv();
  const created = (await supabaseAuthFetch('/admin/users', {
    key: serviceRoleKey,
    method: 'POST',
    body: {
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { role: 'super_admin', is_super_admin: true },
    },
  })) as { id?: string; email?: string } | null;

  const id = String(created?.id || '');
  if (!id) throw new Error('Supabase did not return a user id when creating the super-admin.');

  await supabaseRestFetch('/profiles', {
    key: serviceRoleKey,
    method: 'POST',
    body: { id, is_super_admin: true },
    prefer: 'resolution=merge-duplicates,return=representation',
  }).catch((err) => {
    throw new Error(`Super-admin created but profile flag failed: ${String(err?.message || err)}`);
  });

  return { id, email: String(created?.email || input.email) };
}

/** Verify an operator email+password against Supabase Auth (password grant).
 *  Returns { id, email, accessToken } on success, null on bad credentials.
 *  Does NOT yet confirm the super-admin flag — see verifySuperAdminSignIn. */
export async function verifySuperAdminCredentials(
  email: string,
  password: string,
): Promise<{ id: string; email: string; accessToken: string } | null> {
  if (!supabaseConfigured()) return null;
  const { anonKey } = readSupabaseEnv();
  try {
    const result = (await supabaseAuthFetch('/token?grant_type=password', {
      key: anonKey,
      method: 'POST',
      body: { email, password },
    })) as { access_token?: string; user?: { id?: string; email?: string } } | null;
    if (!result?.access_token || !result.user?.id) return null;
    return {
      id: String(result.user.id),
      email: String(result.user.email || email).trim().toLowerCase(),
      accessToken: String(result.access_token),
    };
  } catch {
    return null;
  }
}

/** Full super-admin sign-in: verify credentials AND confirm the
 *  `profiles.is_super_admin` flag (via the authenticated user's own RLS-scoped
 *  read of their profile row). Returns the master account on success, null when
 *  the credentials are wrong OR the user is not a super-admin. */
export async function verifySuperAdminSignIn(
  email: string,
  password: string,
): Promise<{ id: string; email: string } | null> {
  const credentials = await verifySuperAdminCredentials(email, password);
  if (!credentials) return null;
  try {
    const { anonKey } = readSupabaseEnv();
    const rows = (await supabaseRestFetch(
      `/profiles?id=eq.${encodeURIComponent(credentials.id)}&select=is_super_admin&limit=1`,
      { key: anonKey, bearer: credentials.accessToken },
    )) as Array<{ is_super_admin?: boolean }> | null;
    if (Array.isArray(rows) && rows.length > 0 && rows[0]?.is_super_admin === true) {
      return { id: credentials.id, email: credentials.email };
    }
  } catch {
    // profile read failed — treat as not-a-super-admin (fail closed)
  }
  return null;
}
