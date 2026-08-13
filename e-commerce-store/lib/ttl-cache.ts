/**
 * Minimal in-memory TTL cache for server-side Redis reads.
 *
 * Storefront listing/config endpoints hit Redis on every request; this keeps
 * those reads cheap on warm instances (e.g. `next start` or a warm Vercel
 * lambda) without touching Next's caching model. Writes and admin mutations
 * bypass this helper entirely, so nothing here can corrupt data — the only
 * effect is that public display data may be up to `ttlMs` stale.
 */

type CacheEntry<T = unknown> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

export async function withTtlCache<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const value = await fetcher();
  store.set(key, { value, expiresAt: now + ttlMs });

  // Keep the map bounded by pruning expired entries when it grows large.
  if (store.size > 500) {
    for (const [k, entry] of store) {
      if (entry.expiresAt <= now) store.delete(k);
    }
  }
  return value;
}
