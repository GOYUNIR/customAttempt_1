/**
 * SERVICES / CONFIG — edge-safe configuration gate for `middleware.ts`.
 *
 * The middleware runs in the Edge runtime (Vercel and Cloudflare Workers via
 * OpenNext) where Node builtins are unavailable. This module uses ONLY global
 * `fetch` + `process.env` + a plain Map, mirroring the existing middleware's
 * "inline the edge-safe bits" discipline. It answers one question:
 *
 *     has the Setup Wizard already run?  (true / false / null)
 *
 * `null` means Supabase env is missing or the RPC is unreachable — the
 * middleware FAILS OPEN and keeps the legacy env-based admin behavior.
 */

import {
  fetchIsPlatformConfigured,
  readSupabaseEnv,
  supabaseConfigured,
} from './supabase-client';

const GATE_CACHE_TTL_MS = 5_000;

let gateCache: { value: boolean | null; expiresAt: number } | null = null;

/** Whether Supabase itself is configured (env present) — middleware fast path. */
export function supabaseEnvReady(): boolean {
  return supabaseConfigured();
}

/** Environment info surfaced to the setup page (never any key values). */
export function supabaseEnvSummary(): { configured: boolean; url: boolean; anonKey: boolean; serviceRoleKey: boolean } {
  const { url, anonKey, serviceRoleKey } = readSupabaseEnv();
  return { configured: Boolean(url && anonKey), url: Boolean(url), anonKey: Boolean(anonKey), serviceRoleKey: Boolean(serviceRoleKey) };
}

/** The middleware gate: is the platform configured? null = cannot tell. */
export async function isPlatformConfiguredEdge(): Promise<boolean | null> {
  if (!supabaseConfigured()) return null;
  const now = Date.now();
  if (gateCache && gateCache.expiresAt > now) return gateCache.value;
  const value = await fetchIsPlatformConfigured();
  gateCache = { value, expiresAt: now + GATE_CACHE_TTL_MS };
  return value;
}

/** Forget the cached gate (called nowhere at the edge today, exported for tests). */
export function clearPlatformConfiguredEdgeCache(): void {
  gateCache = null;
}
