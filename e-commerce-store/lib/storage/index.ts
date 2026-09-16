/**
 * STORAGE FACTORY — select the data backend.
 *
 * The provider is chosen ONCE per process by `STORAGE_PROVIDER`:
 *   - `supabase` / unset    → Supabase (the DEFAULT primary store — `store_kv` +
 *     `global_platform_settings`). Unconfigured means UNAVAILABLE, never a
 *     silent switch to another store.
 *   - `cloudflare-kv`       → Workers KV adapter (zero third-party storage;
 *     see the concurrency caveats in cloudflare-kv.ts before routing
 *     payment/raffle writes at it).
 *   - `upstash`             → Upstash REST Redis (battle-tested engine; runs on
 *     Vercel, Netlify, Cloudflare via Upstash's Marketplace integration, or any
 *     Node host).
 *
 * Every route reaches this through `createKvClient()` in
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

/** Instantiate ONE provider, or null. NEVER a different provider than the one
 *  selected -- see the fail-closed note below. `cloudflare-kv` never returns
 *  null (it falls back to an in-memory store for local dev); `supabase` and
 *  `upstash` return null when unconfigured. */
function createSingleClient(provider: StorageProvider): StorageClient | null {
  if (provider === 'supabase') {
    // NO FALLBACK. This used to drop to Upstash when Supabase was selected but
    // unconfigured, which meant a missing or mistyped SUPABASE_URL silently
    // routed every write to a DIFFERENT datastore instead of failing -- the
    // store would look healthy while the real database went stale. Any machine
    // holding both sets of credentials (a dev box, a half-migrated deploy)
    // could diverge without a single error.
    //
    // Selecting a provider now means that provider or nothing. Callers already
    // treat a null client as "storage unavailable" and answer 503, which is
    // the correct, visible failure for a misconfiguration.
    const supabase = createSupabaseClient();
    if (!supabase) {
      console.error(
        '[storage] STORAGE_PROVIDER=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing. ' +
          'Refusing to fall back to another store; storage is unavailable until this is fixed.',
      );
    }
    return supabase;
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
