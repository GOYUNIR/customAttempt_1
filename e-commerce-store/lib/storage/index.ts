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
import { ReplicatedStorageClient } from './replicated';
import { createSupabaseClient } from './supabase';
import { createUpstashClient } from './upstash';
import {
  resolveStorageProvider,
  resolveReplicaProviders,
  type StorageClient,
  type StorageProvider,
} from './types';

export * from './types';
export { ReplicatedStorageClient } from './replicated';

/** Instantiate ONE provider. `cloudflare-kv` never returns null (it falls back
 *  to an in-memory store for local dev); `supabase` falls back to Upstash when
 *  Supabase is not configured; `upstash` returns null when unconfigured. */
function createSingleClient(provider: StorageProvider): StorageClient | null {
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

export function createStorageClient(): StorageClient | null {
  const provider: StorageProvider = resolveStorageProvider();
  const primary = createSingleClient(provider);

  // Write-through mirrors (data-loss protection). `STORAGE_REPLICAS` lists
  // INDEPENDENT vendors that receive a copy of every write. The primary vendor
  // is excluded from the mirror set, and any unconfigured mirror is skipped
  // (createSingleClient returns null for an unconfigured upstash).
  const replicaProviders = resolveReplicaProviders().filter((p) => p !== provider);
  const replicas = replicaProviders
    .map((p) => createSingleClient(p))
    .filter((client): client is StorageClient => client !== null);

  if (primary && replicas.length > 0) {
    return new ReplicatedStorageClient(primary, replicas);
  }
  if (!primary && replicas.length > 0) {
    // Primary selected but unreachable — serve from the first mirror so the
    // store stays readable during a primary-vendor outage.
    const [head, ...rest] = replicas;
    return new ReplicatedStorageClient(head, rest);
  }
  return primary;
}

/** The active provider name — used by the admin SetUp dashboard. */
export function activeStorageProvider(): StorageProvider {
  return resolveStorageProvider();
}

/** The active mirror provider names (for the admin SetUp dashboard). */
export function activeReplicaProviders(): StorageProvider[] {
  return resolveReplicaProviders().filter((p) => p !== resolveStorageProvider());
}
