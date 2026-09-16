/**
 * A short-lived, best-effort mutex for the handful of read-modify-write
 * critical sections that can't be expressed as a single atomic command
 * (inventory decrement, dedupe "has this Stripe event been handled",
 * points/promo balance debits). None of the three storage backends expose
 * Redis MULTI/WATCH or Lua scripting through `StorageClient`, but `hincrby`
 * is guaranteed atomic on every backend (see lib/storage/types.ts), so it
 * doubles as a lock: the caller that flips a hash field from 0 to 1 is the
 * only caller that "won" it.
 *
 * This is NOT a general-purpose distributed lock (no fencing tokens, no
 * fairness) — it is sized for the narrow job of serializing a handful of
 * concurrent requests around a few milliseconds of Redis round-trips, with a
 * short TTL so a crashed holder never wedges the key permanently.
 */

import type { StorageClient } from '@/lib/storage/types';

const DEFAULT_TTL_SECONDS = 10;
const DEFAULT_RETRIES = 20;
const RETRY_DELAY_MS = 75;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Try once to acquire `lockKey`. Returns true if this call won the lock. */
/**
 * Acquire, atomically or not at all.
 *
 * THIS USED TO BE `hincrby(lockKey, 'lock', 1) === 1`, which is atomic on real
 * Redis and NOT atomic on what production actually runs. STORAGE_PROVIDER is
 * "supabase", so hincrby went through CloudflareKvStorageClient.mutate --
 * read, compute, write -- and two callers could both read 0, both compute 1,
 * and both believe they held the lock. Measured against production store_kv:
 * 10 contenders, 4 "acquired", 2 inside the critical section simultaneously.
 * (scripts/verify-lock-mutual-exclusion.ts)
 *
 * Every inventory decrement, draw, promo-count and points redemption in this
 * codebase was relying on that.
 *
 * Now it uses setIfAbsent, which is a single atomic operation on the backing
 * store (a plain INSERT against store_kv's primary key for Supabase, SET NX
 * for Upstash). A store with no atomic primitive gets NO EMULATION: acquire
 * fails, withRedisLock returns { ok: false }, and callers take their existing
 * "could not lock" path. A lock that silently does not lock is strictly worse
 * than one that admits it cannot.
 */
async function tryAcquire(redis: StorageClient, lockKey: string, ttlSeconds: number): Promise<boolean> {
  const client = redis as StorageClient & {
    setIfAbsent?: (key: string, value: string, ttlSeconds: number) => Promise<boolean>;
  };
  if (typeof client.setIfAbsent !== 'function') {
    console.error(
      '[redis-lock] storage backend exposes no atomic setIfAbsent — refusing to emulate a lock. ' +
        'Every guarded section will report contention until this is fixed.',
    );
    return false;
  }
  try {
    return await client.setIfAbsent(lockKey, String(Date.now()), ttlSeconds);
  } catch (err) {
    // An unsupported store, or a genuine backend failure. Either way we do not
    // hold the lock, and pretending otherwise is the bug this replaced.
    console.error('[redis-lock] atomic acquire failed', lockKey, (err as Error)?.message || err);
    return false;
  }
}

async function release(redis: StorageClient, lockKey: string): Promise<void> {
  await redis.del(lockKey).catch(() => {});
}

/**
 * Run `fn` while holding a lock scoped to `name`. Retries acquisition with a
 * short backoff for up to ~1.5s by default before giving up. Returns
 * `{ ok: false }` (without running `fn`) when the lock could not be acquired
 * — callers should treat that as "try again" (e.g. let a Stripe webhook
 * retry) rather than silently skipping the operation.
 */
export async function withRedisLock<T>(
  redis: StorageClient,
  name: string,
  fn: () => Promise<T>,
  opts: { ttlSeconds?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<{ ok: true; value: T } | { ok: false }> {
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const lockKey = `cache:lock:${name}`;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (await tryAcquire(redis, lockKey, ttlSeconds)) {
      try {
        const value = await fn();
        return { ok: true, value };
      } finally {
        await release(redis, lockKey);
      }
    }
    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }
  return { ok: false };
}
