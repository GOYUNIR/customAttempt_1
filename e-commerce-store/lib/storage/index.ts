/**
 * STORAGE FACTORY — select the data backend.
 *
 * The provider is chosen ONCE per process by `STORAGE_PROVIDER`:
 *   - `supabase` / unset    → Supabase (the DEFAULT primary store — `store_kv` +
 *     `global_platform_settings`); falls back to Redis when Supabase env is absent.
 *   - `cloudflare-kv`       → Workers KV adapter (zero third-party storage;
 *     see the concurrency caveats in cloudflare-kv.ts before routing
 *     payment/raffle writes at it).
 *   - `upstash`             → Upstash REST Redis (battle-tested engine; runs on
 *     Vercel, Netlify, Cloudflare via Upstash's Marketplace integration, or any
 *     Node host).
 *
 * Every route reaches this through `createRedisClient()` in
 * `lib/server-config.ts`, so swapping the backend is a one-line env change —
 * no code changes needed anywhere else.
 */

import { createCloudflareKvClient } from './cloudflare-kv';
import { createSupabaseClient } from './supabase';
import { createUpstashClient } from './upstash';
import { resolveStorageProvider, type StorageClient, type StorageProvider } from './types';

export * from './types';

export function createStorageClient(): StorageClient | null {
  const provider: StorageProvider = resolveStorageProvider();
  if (provider === 'supabase') {
    const supabase = createSupabaseClient();
    if (supabase) return supabase;
    // Supabase selected but not actually configured → fall back to Redis.
    return createUpstashClient();
  }
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
