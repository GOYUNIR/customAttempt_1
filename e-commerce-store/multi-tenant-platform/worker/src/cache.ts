/**
 * KV cache access for the compiled per-tenant payload.
 *
 * Fast path: `getCachedSite` — instant hit if the key exists.
 * Slow path: `setCachedSite` — written async after the Supabase build so the
 * next hit for that hostname is served from KV.
 */
import { cacheKeyForSite } from '../../shared/hostname.ts';
import type { CompiledSite } from '../../shared/types.ts';
import type { Env } from './env';

export const DEFAULT_CACHE_VERSION = 1;
export const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h per spec

export function resolveCacheVersion(env: Env): number {
  const parsed = Number.parseInt(env.CACHE_VERSION ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_VERSION;
}

export function resolveTtlSeconds(env: Env): number {
  const parsed = Number.parseInt(env.SITE_CACHE_TTL_SECONDS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

function isCompiledSite(value: unknown): value is CompiledSite {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.cacheVersion === 'number' &&
    typeof candidate.compiledAt === 'string' &&
    typeof candidate.site === 'object' &&
    candidate.site !== null &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null &&
    Array.isArray(candidate.products)
  );
}

export async function getCachedSite(env: Env, siteKey: string): Promise<CompiledSite | null> {
  const key = cacheKeyForSite(siteKey, resolveCacheVersion(env));
  const raw: unknown = await env.SITE_CACHE.get(key, 'json');
  return isCompiledSite(raw) ? (raw as CompiledSite) : null;
}

export async function setCachedSite(env: Env, siteKey: string, compiled: CompiledSite): Promise<void> {
  const key = cacheKeyForSite(siteKey, resolveCacheVersion(env));
  await env.SITE_CACHE.put(key, JSON.stringify(compiled), {
    expirationTtl: resolveTtlSeconds(env),
  });
}
