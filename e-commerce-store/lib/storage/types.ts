/**
 * ─────────────────────────────────────────────────────────────────────────────
 * STORAGE LAYER — interface (the future-proofing seam)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The app treats its key space through a Redis-compatible command surface
 * (hashes, lists, sets, zsets), but the data layer is backend-agnostic — every
 * route reaches the store through `createRedisClient()` in lib/server-config.ts.
 * This interface is the contract between the app and whatever backend actually
 * stores the bytes, so the data layer is NOT welded to the `@upstash/redis`
 * SDK:
 *
 *   - `lib/storage/supabase.ts`     → Supabase PostgREST adapter (the DEFAULT
 *     primary store — `store_kv` + `global_platform_settings`).
 *   - `lib/storage/upstash.ts`      → Upstash REST adapter (one of three drivers;
 *     runs on Vercel, Netlify, Cloudflare via Upstash's Cloudflare integration,
 *     or any Node host).
 *   - `lib/storage/cloudflare-kv.ts`→ Workers-KV adapter (no third-party store:
 *     good for admin/config/low-concurrency paths; see the concurrency caveats
 *     in that file before pointing payment/raffle writes at it).
 *   - `lib/storage/index.ts`        → `createStorageClient()` factory, selects a
 *     provider from `STORAGE_PROVIDER` (default `supabase`).
 *
 * The interface deliberately covers EXACTLY the command surface the codebase
 * uses (verified by inventory: get/set/setex, hset/hget/hgetall/hdel/hincrby,
 * lrange/lset/llen/ltrim/lrem/rpush, sadd/srem/sismember/smembers,
 * zadd/zrange/zremrangebyscore/zcard, keys/del/exists/expire/pexpire/ttl/pttl/
 * incr/incrby/renamenx/type/ping). Return types are loose where callers use
 * the value generically so both adapters satisfy the interface with zero
 * behavioral surprises.
 *
 * RULES FOR FUTURE AGENTS
 * -----------------------
 * 1. NEVER `import { Redis } from '@upstash/redis'` outside
 *    `lib/storage/upstash.ts`. Everything else talks to `StorageClient`.
 * 2. If a new feature needs a command NOT in this interface, add it here AND
 *    implement it in BOTH adapters (Upstash passes through natively; KV needs
 *    an envelope/encoding). Keep the two in lock-step or the KV provider
 *    silently breaks at runtime.
 * 3. `lib/server-config.ts` helper signatures use `redis: StorageClient`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The data-backend contract. Structurally compatible with the Upstash `Redis`
 * class (an Upstash instance satisfies every signature below), and implemented
 * by the Workers-KV adapter in cloudflare-kv.ts.
 */
export interface StorageClient {
  ping(): Promise<unknown>;

  // ── Strings ──────────────────────────────────────────────────────────────
  get(key: string): Promise<unknown>;
  set(key: string, value: string | number | unknown): Promise<unknown>;
  /** Set a string value with a TTL measured in seconds. */
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  ttl(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;

  // ── Keyspace ─────────────────────────────────────────────────────────────
  /** Glob-style pattern (`*` / `prefix:*`). Adapters resolve the literal
   *  prefix and list/scan the rest. */
  keys(pattern: string): Promise<string[]>;
  /** `string` | `hash` | `list` | `set` | `zset` | `none`. */
  type(key: string): Promise<string>;
  /** Atomic rename — 0 when the target already exists, 1 on success. */
  renamenx(oldKey: string, newKey: string): Promise<number>;

  // ── Hashes ───────────────────────────────────────────────────────────────
  hset(key: string, data: Record<string, string | number>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hincrby(key: string, field: string, by: number): Promise<number>;

  // ── Lists ────────────────────────────────────────────────────────────────
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  lset(key: string, index: number, value: string): Promise<unknown>;
  llen(key: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrem(key: string, count: number, value: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;

  // ── Sets ─────────────────────────────────────────────────────────────────
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;

  // ── Sorted sets ──────────────────────────────────────────────────────────
  zadd(key: string, entry: { score: number; member: string }): Promise<number>;
  /** With `withScores: true` returns a FLAT `[member, score, member, score…]`
   *  array (Redis ZRANGE-WITHSCORES shape). */
  zrange(
    key: string,
    start: number,
    stop: number,
    opts?: { withScores?: boolean },
  ): Promise<Array<string | number>>;
  /** Score of a member in a sorted set, or null when the member is absent
   *  (returns null for wrong-type keys too, so callers can treat it like
   *  SISMEMBER). Used by the bounded dedupe sets (`entries:processed`,
   *  `entries:email_sent`). */
  zscore(key: string, member: string): Promise<number | null>;
  zremrangebyscore(key: string, min: number, max: number): Promise<number>;
  zcard(key: string): Promise<number>;
}

export type StorageProvider = 'supabase' | 'upstash' | 'cloudflare-kv';

/** The env var name that selects the backend provider. */
export const STORAGE_PROVIDER_ENV = 'STORAGE_PROVIDER';

/**
 * Resolve the active storage backend.
 *
 * Priority:
 *   1. Explicit `STORAGE_PROVIDER` (supabase | upstash/redis | cloudflare-kv/kv/d1).
 *   2. Supabase when `SUPABASE_URL` + a key (`SUPABASE_SERVICE_ROLE_KEY` or
 *      `SUPABASE_ANON_KEY`) are present.
 *   3. Default (nothing detected) — Supabase, the default primary store. The
 *      factory then falls back to Upstash Redis, returning null when no store is
 *      configured at all (which the app treats as "no store yet").
 *
 * NOTE: this selects the ADAPTER to instantiate. The admin-portal READINESS gate
 * (which drivers are acceptable) lives in lib/env-discovery.ts → detectStorageDrivers().
 */
export function resolveStorageProvider(): StorageProvider {
  const raw = String(process.env[STORAGE_PROVIDER_ENV] || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (raw === 'supabase' || raw === 'postgres' || raw === 'pg') return 'supabase';
  if (raw === 'cloudflare-kv' || raw === 'cloudflare' || raw === 'kv' || raw === 'd1' || raw === 'workers-kv') {
    return 'cloudflare-kv';
  }
  if (raw === 'upstash' || raw === 'redis') return 'upstash';
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (url && key) return 'supabase';
  return 'supabase';
}
