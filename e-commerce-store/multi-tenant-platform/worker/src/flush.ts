/**
 * Cache invalidation hook for the Admin Portal.
 *
 * When an authenticated user updates their layout in the admin dashboard, the
 * Admin Portal POSTs the site's hostname here. The handler deletes every cached
 * version of that tenant's KV key (`site_cache:v<N>:<siteKey>`), so the next
 * visitor is served a freshly compiled payload — the Worker re-warms KV on the
 * following miss (fast path).
 *
 *   POST /api/flush-cache
 *   Authorization: Bearer $FLUSH_CACHE_SECRET
 *   { "hostname": "demo.yourplatform.com" }
 *
 * `hostname` may be a full host (`demo.yourplatform.com`, `www.shop.acme.com`),
 * a bare platform subdomain (`demo`) or a bare custom domain (`shop.acme.com`).
 * Resolution mirrors the fast path exactly (shared/hostname.ts), so the deleted
 * keys are always the keys the Worker reads.
 */
import { normalizeHostname, resolveSiteKey } from '../../shared/hostname.ts';
import { deleteCachedSite } from './cache.ts';
import type { Env } from './env.ts';

export const FLUSH_CACHE_PATH = '/api/flush-cache';

interface FlushPayload {
  hostname?: unknown;
}

export interface FlushCacheResult {
  ok: boolean;
  hostname?: string;
  siteKey?: string;
  flushedKeys?: string[];
  error?: string;
}

/** Constant-time string comparison (Edge-safe — no Node crypto in workerd). */
function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

/** Fail closed: without a configured secret the flush endpoint is unreachable. */
function isAuthorized(request: Request, env: Env): boolean {
  const secret = env.FLUSH_CACHE_SECRET ?? '';
  if (secret.length === 0) return false;
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  return header.startsWith(prefix) && timingSafeEqual(header.slice(prefix.length), secret);
}

/**
 * Derive the tenant's KV siteKey from a hostname, mirroring the fast path:
 *  - `demo.yourplatform.com` → `demo`
 *  - `www.shop.acme.com`     → `shop.acme.com`
 * A bare key (`demo`, `shop.acme.com`) passes through unchanged.
 */
function siteKeyForHostname(hostname: string, platformRootDomain: string): string {
  const resolved = resolveSiteKey(hostname, platformRootDomain);
  return resolved ? resolved.siteKey : normalizeHostname(hostname);
}

export async function handleFlushCache(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed — POST only' }, 405);
  }
  if (!isAuthorized(request, env)) {
    return jsonResponse({ ok: false, error: 'Unauthorized — send Authorization: Bearer $FLUSH_CACHE_SECRET' }, 401);
  }

  let payload: FlushPayload;
  try {
    payload = (await request.json()) as FlushPayload;
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const rawHostname = typeof payload.hostname === 'string' ? payload.hostname.trim() : '';
  if (!rawHostname) {
    return jsonResponse({ ok: false, error: 'Missing required "hostname" string in the JSON body' }, 400);
  }

  const hostname = normalizeHostname(rawHostname);
  if (!hostname) {
    return jsonResponse({ ok: false, error: 'Invalid hostname' }, 400);
  }

  const siteKey = siteKeyForHostname(hostname, env.PLATFORM_ROOT_DOMAIN);
  const flushedKeys = await deleteCachedSite(env, siteKey);

  return jsonResponse({ ok: true, hostname, siteKey, flushedKeys }, 200);
}

function jsonResponse(body: FlushCacheResult, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
