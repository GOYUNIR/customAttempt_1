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

export function readSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } {
  const url = (process.env[SUPABASE_ENV_URL] || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = (process.env[SUPABASE_ENV_ANON_KEY] || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  const serviceRoleKey = (process.env[SUPABASE_ENV_SERVICE_ROLE_KEY] || '').trim();
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
