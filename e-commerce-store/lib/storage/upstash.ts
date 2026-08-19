/**
 * Upstash Redis adapter — the DEFAULT storage provider.
 *
 * Wraps the `@upstash/redis` REST client (the only file in the codebase that
 * is allowed to import it — see lib/storage/types.ts). The Upstash instance is
 * structurally compatible with `StorageClient`; the cast documents that the
 * app treats it as the generic contract, not as the SDK.
 *
 * Env resolution matches the old `createRedisClient()` behavior exactly:
 *   URL:  UPSTASH_REDIS_REST_URL → KV_REST_API_URL → REDIS_REST_URL → REDIS_URL
 *         → KV_URL
 *   TOKEN: UPSTASH_REDIS_REST_TOKEN → KV_REST_API_TOKEN → REDIS_REST_TOKEN
 *         → REDIS_TOKEN
 * A `redis://` / `rediss://` wire-protocol URL is skipped (the REST client
 * cannot use it) so construction never fails on Upstash's own default vars.
 */

import { Redis } from '@upstash/redis';
import type { StorageClient } from './types';

function resolveRedisRestUrl(): string {
  const candidates = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'REDIS_REST_URL', 'REDIS_URL', 'KV_URL'];
  for (const name of candidates) {
    const value = String(process.env[name] || '').trim();
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.includes('://')) continue; // redis:// / rediss:// — REST client can't use it
    return value;
  }
  return '';
}

export function createUpstashClient(): StorageClient | null {
  const url = resolveRedisRestUrl();
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN ??
    process.env.REDIS_REST_TOKEN ??
    process.env.REDIS_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token }) as unknown as StorageClient;
  } catch {
    return null;
  }
}
