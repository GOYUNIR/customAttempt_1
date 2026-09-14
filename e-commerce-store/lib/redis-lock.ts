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
async function tryAcquire(redis: StorageClient, lockKey: string, ttlSeconds: number): Promise<boolean> {
  const value = await redis.hincrby(lockKey, 'lock', 1);
  if (value === 1) {
    // We're the first to touch this key since it last expired/was deleted —
    // set the TTL so a crash between acquire and release can't wedge it.
    await redis.expire(lockKey, ttlSeconds).catch(() => {});
    return true;
  }
  return false;
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
