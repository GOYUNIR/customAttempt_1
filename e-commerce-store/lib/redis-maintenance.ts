/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REDIS MAINTENANCE — bounded dedupe + orphaned-state sweep
 *
 * Two problems this module solves:
 *
 * 1. **Unbounded dedupe sets.** `entries:processed` (Stripe session ids) and
 *    `entries:email_sent` (`variant:size:email` rows) used to be plain SETS
 *    that grew FOREVER — every checkout session and every entry email added a
 *    member that was never removed, so a busy store's Redis grew without bound.
 *    They are now **sorted sets scored by timestamp**: a membership check is a
 *    ZSCORE, and every write prunes members older than a retention window
 *    (72h for processed sessions = Stripe's webhook retry window; 30 days for
 *    sent emails = a huge safety margin over the ~days-long repair window).
 *    `ensureDedupeZset()` self-migrates a legacy SET to the bounded ZSET the
 *    first time it is written after an upgrade, so no admin step is required.
 *
 * 2. **Orphaned state for deleted products/users.** Product deletion removes
 *    the product row, but per-product hash fields (entries:stats counters,
 *    entries:last_auto timestamps, ops:overrides `product:<id>` fields,
 *    ops:live_state rows) and pool keys can linger. `sweepOrphanedProductState`
 *    prunes every field/key whose product (or user) no longer exists. It is
 *    run by the admin → Developer → Tidy Redis Schema action and the admin
 *    self-test helper so operators can keep a live store tidy without a wipe.
 *
 * Self-contained on purpose (relative imports only, no `@/` alias) so the
 * node --test runner can load it directly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  PROCESSED_SESSIONS_KEY,
  ENTRY_EMAIL_SENT_KEY,
  PRODUCTS_KEY,
  USERS_KEY,
  STORED_CARTS_KEY,
  LIVE_STATE_KEY,
  OVERRIDES_KEY,
  POOL_STATS_KEY,
  LAST_AUTO_DRAW_HASH_KEY,
  POOL_KEY_PREFIX,
  INTENT_KEY_PREFIX,
  WAITLIST_POOL_PREFIX,
} from './redis-keys.ts';
import type { StorageClient } from './storage/types.ts';

/** Stripe re-delivers webhook events for up to ~3 days; after that a session id
 *  will never be seen again and can be dropped from the dedupe index. */
export const DEDUPE_PROCESSED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** Confirmation emails are only re-sent by webhook/confirm-setup retries within
 *  a few days of checkout; 30 days is a huge safety margin over that. */
export const DEDUPE_EMAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ── Bounded dedupe (processed sessions + sent emails) ────────────────────────

/** Convert a legacy SET at `key` into the timestamp-scored ZSET format. New
 *  members get score = now so they live the full retention window. Safe to run
 *  on any key (type checks); a wrong-type key is left untouched. */
export async function ensureDedupeZset(redis: StorageClient, key: string): Promise<void> {
  try {
    const type = await redis.type(key);
    if (type === 'zset' || type === 'none') return;
    if (type !== 'set') return;
    const members = (await redis.smembers(key)) || [];
    await redis.del(key);
    if (members.length > 0) {
      const now = Date.now();
      for (const member of members) {
        await redis.zadd(key, { score: now, member });
      }
    }
  } catch {
    /* a hiccup must never break checkout — dedupe stays best-effort */
  }
}

/** Membership check that tolerates both the legacy SET and the bounded ZSET
 *  shapes (an in-flight migration can never cause a double-process). */
export async function isDedupeMember(redis: StorageClient, key: string, member: string): Promise<boolean> {
  try {
    const type = await redis.type(key);
    if (type === 'set') return (await redis.sismember(key, member)) === 1;
    if (type === 'zset') return (await redis.zscore(key, member)) !== null;
    return false;
  } catch {
    return false;
  }
}

/** Record a member with a `now` timestamp and prune anything older than
 *  `windowMs`. Self-migrates a legacy SET on the first write after upgrade. */
export async function markDedupeMember(
  redis: StorageClient,
  key: string,
  member: string,
  windowMs: number,
): Promise<void> {
  try {
    await ensureDedupeZset(redis, key);
    await redis.zadd(key, { score: Date.now(), member });
    await redis.zremrangebyscore(key, 0, Date.now() - windowMs);
  } catch {
    /* best-effort: the underlying entry/email logic is the real gate */
  }
}

/** Convenience wrappers for the two named dedupe keys. */
export function markProcessedSession(redis: StorageClient, sessionId: string): Promise<void> {
  return markDedupeMember(redis, PROCESSED_SESSIONS_KEY, sessionId, DEDUPE_PROCESSED_WINDOW_MS);
}
export function isProcessedSession(redis: StorageClient, sessionId: string): Promise<boolean> {
  return isDedupeMember(redis, PROCESSED_SESSIONS_KEY, sessionId);
}
export function markEntryEmailSent(redis: StorageClient, emailDedupe: string): Promise<void> {
  return markDedupeMember(redis, ENTRY_EMAIL_SENT_KEY, emailDedupe, DEDUPE_EMAIL_WINDOW_MS);
}
export function isEntryEmailSent(redis: StorageClient, emailDedupe: string): Promise<boolean> {
  return isDedupeMember(redis, ENTRY_EMAIL_SENT_KEY, emailDedupe);
}

// ── Orphaned-state sweep ─────────────────────────────────────────────────────

export type SweepResult = {
  entriesStats: number;
  lastAuto: number;
  overrides: number;
  liveState: number;
  carts: number;
  emptyPools: number;
  orphanPools: number;
};

function tryParse(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Product name from `sub:<name>:<size>` / `int:<name>:<size>` stats fields. */
function productNameFromStatField(field: string): string {
  const withoutKind = field.startsWith('sub:')
    ? field.slice(4)
    : field.startsWith('int:')
      ? field.slice(4)
      : field;
  const colon = withoutKind.indexOf(':');
  return (colon > 0 ? withoutKind.slice(0, colon) : withoutKind).trim().toLowerCase();
}

/** Product name from an `entries:last_auto` field (`<name>:<size>`). */
function productNameFromLastAutoField(field: string): string {
  const colon = field.indexOf(':');
  return (colon > 0 ? field.slice(0, colon) : field).trim().toLowerCase();
}

/** Product name from an `entries:pool:` / `entries:intent:` / `entries:waitlist:`
 *  key (first colon after the fixed 2-segment namespace prefix). */
function productNameFromPoolKeyLike(key: string, prefix: string): string {
  const withoutPrefix = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const colon = withoutPrefix.indexOf(':');
  return (colon > 0 ? withoutPrefix.slice(0, colon) : withoutPrefix).trim().toLowerCase();
}

/** Product id from an `ops:live_state` field (`<productId>-<slug>:<size>`).
 *  The slug segment is unpredictable, so match against the known id set. */
function liveStateMatchesAnyProduct(field: string, productIds: Set<string>): boolean {
  const colon = field.lastIndexOf(':');
  const left = colon > 0 ? field.slice(0, colon) : field;
  for (const id of productIds) {
    if (left === id || left.startsWith(`${id}-`)) return true;
  }
  return false;
}


/**
 * Prune every per-product / per-user record whose product or user no longer
 * exists in the canonical `store:` namespace. Idempotent and defensive — each
 * namespace is wrapped so one hiccup can never break the whole sweep.
 */
export async function sweepOrphanedProductState(redis: StorageClient): Promise<SweepResult> {
  const result: SweepResult = {
    entriesStats: 0,
    lastAuto: 0,
    overrides: 0,
    liveState: 0,
    carts: 0,
    emptyPools: 0,
    orphanPools: 0,
  };

  try {
    const productsRaw = (await redis.hgetall(PRODUCTS_KEY)) || {};
    const productIds = new Set(Object.keys(productsRaw));
    const productNames = new Set<string>();
    for (const value of Object.values(productsRaw)) {
      const parsed = tryParse(value);
      const name = String(parsed?.name || '').trim().toLowerCase();
      if (name) productNames.add(name);
    }

    // entries:stats — one field per product+size (`sub:` / `int:`).
    try {
      const statsRaw = (await redis.hgetall(POOL_STATS_KEY)) || {};
      const deletes: string[] = [];
      for (const field of Object.keys(statsRaw)) {
        const name = productNameFromStatField(field);
        if (name && !productNames.has(name)) deletes.push(field);
      }
      if (deletes.length > 0) {
        await redis.hdel(POOL_STATS_KEY, ...deletes);
        result.entriesStats = deletes.length;
      }
    } catch {}

    // entries:last_auto — one field per product+size.
    try {
      const lastAutoRaw = (await redis.hgetall(LAST_AUTO_DRAW_HASH_KEY)) || {};
      const deletes: string[] = [];
      for (const field of Object.keys(lastAutoRaw)) {
        const name = productNameFromLastAutoField(field);
        if (name && !productNames.has(name)) deletes.push(field);
      }
      if (deletes.length > 0) {
        await redis.hdel(LAST_AUTO_DRAW_HASH_KEY, ...deletes);
        result.lastAuto = deletes.length;
      }
    } catch {}

    // ops:overrides — `product:<id>` fields only.
    try {
      const overridesRaw = (await redis.hgetall(OVERRIDES_KEY)) || {};
      const deletes: string[] = [];
      for (const field of Object.keys(overridesRaw)) {
        const match = /^product:(.+)$/.exec(field);
        if (match && !productIds.has(match[1])) deletes.push(field);
      }
      if (deletes.length > 0) {
        await redis.hdel(OVERRIDES_KEY, ...deletes);
        result.overrides = deletes.length;
      }
    } catch {}



    // ops:live_state — fields are `<productId>-<slug>:<size>`.
    try {
      const liveRaw = (await redis.hgetall(LIVE_STATE_KEY)) || {};
      const deletes: string[] = [];
      for (const field of Object.keys(liveRaw)) {
        if (!liveStateMatchesAnyProduct(field, productIds)) deletes.push(field);
      }
      if (deletes.length > 0) {
        await redis.hdel(LIVE_STATE_KEY, ...deletes);
        result.liveState = deletes.length;
      }
    } catch {}

    // store:carts — fields are user ids; drop carts for deleted accounts.
    try {
      const cartsRaw = (await redis.hgetall(STORED_CARTS_KEY)) || {};
      if (Object.keys(cartsRaw).length > 0) {
        const usersRaw = (await redis.hgetall(USERS_KEY)) || {};
        const userIds = new Set(Object.keys(usersRaw));
        const deletes: string[] = [];
        for (const field of Object.keys(cartsRaw)) {
          if (!userIds.has(field)) deletes.push(field);
        }
        if (deletes.length > 0) {
          await redis.hdel(STORED_CARTS_KEY, ...deletes);
          result.carts = deletes.length;
        }
      }
    } catch {}

    // Pool/intent/waitlist keys — drop empty lists and lists whose product name
    // no longer resolves (deleted products). Draws already clean their pools on
    // the final draw; this catches product deletion + interrupted draws.
    const prefixes = [POOL_KEY_PREFIX, INTENT_KEY_PREFIX, WAITLIST_POOL_PREFIX];
    for (const prefix of prefixes) {
      try {
        const keys = (await redis.keys(`${prefix}*`)) || [];
        for (const key of keys) {
          try {
            const length = Number(await redis.llen(key)) || 0;
            const name = productNameFromPoolKeyLike(key, prefix);
            if (length === 0) {
              await redis.del(key);
              result.emptyPools += 1;
            } else if (name && !productNames.has(name)) {
              await redis.del(key);
              result.orphanPools += 1;
            }
          } catch {
            /* a key that vanished mid-sweep is fine */
          }
        }
      } catch {}
    }
  } catch {
    /* the sweep must never throw — callers treat it as best-effort */
  }

  return result;
}

/** Migrate + prune the two dedupe structures. Returns members removed. */
export async function maintainDedupeStructures(redis: StorageClient): Promise<number> {
  let pruned = 0;
  try {
    await ensureDedupeZset(redis, PROCESSED_SESSIONS_KEY);
    pruned += await redis.zremrangebyscore(PROCESSED_SESSIONS_KEY, 0, Date.now() - DEDUPE_PROCESSED_WINDOW_MS);
  } catch {}
  try {
    await ensureDedupeZset(redis, ENTRY_EMAIL_SENT_KEY);
    pruned += await redis.zremrangebyscore(ENTRY_EMAIL_SENT_KEY, 0, Date.now() - DEDUPE_EMAIL_WINDOW_MS);
  } catch {}
  return pruned;
}
