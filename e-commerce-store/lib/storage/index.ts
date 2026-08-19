/**
 * STORAGE FACTORY — select the data backend.
 *
 * The provider is chosen ONCE per process by `STORAGE_PROVIDER`:
 *   - (unset / `upstash`)  → Upstash REST Redis — the DEFAULT and the
 *     recommended production engine on every platform (Vercel, Netlify,
 *     Cloudflare via Upstash's Marketplace integration, any Node host).
 *   - `cloudflare-kv`       → Workers KV adapter (zero third-party storage;
 *     see the concurrency caveats in cloudflare-kv.ts before routing
 *     payment/raffle writes at it).
 *
 * Every route reaches this through `createRedisClient()` in
 * `lib/server-config.ts`, so swapping the backend is a one-line env change —
 * no code changes needed anywhere else.
 */

import { createCloudflareKvClient } from './cloudflare-kv';
import { createUpstashClient } from './upstash';
import { resolveStorageProvider, type StorageClient, type StorageProvider } from './types';

export * from './types';

export function createStorageClient(): StorageClient | null {
  const provider: StorageProvider = resolveStorageProvider();
  if (provider === 'cloudflare-kv') {
    // Never returns null (falls back to an in-memory store for local dev).
    return createCloudflareKvClient();
  }
  return createUpstashClient();
}

/** The active provider name — used by the admin SetUp dashboard. */
export function activeStorageProvider(): StorageProvider {
  return resolveStorageProvider();
}
