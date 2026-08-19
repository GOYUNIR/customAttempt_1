/**
 * CLOUDFLARE WORKERS KV ADAPTER — implements the `StorageClient` contract on
 * top of Workers KV so the app can run with NO third-party database.
 *
 * Every logical key is one KV entry whose value is a small envelope:
 *   { "v": <value>, "e": <expiresAtMs | null>, "t": <type> }
 *   t = "string" | "number" | "hash" | "list" | "set" | "zset"
 * Hashes/lists/sets/zsets are whole JSON documents (read-modify-write).
 *
 * CONCURRENCY CAVEATS — Workers KV is EVENTUALLY CONSISTENT with no atomic
 * counters, so every collection mutation below is a read-modify-write. SAFE:
 * admin edits, config, product CRUD, settings, seed/wipe, the raw-data viewer,
 * rate-limit bumps. RISKY: concurrent customer checkouts appending to the same
 * raffle pool (rpush) or the double-entry `sadd` guards — under a real traffic
 * spike entries can be lost. For production payment/raffle writes keep the
 * DEFAULT provider: Upstash Redis (which runs on Cloudflare via Upstash's
 * Marketplace integration). This adapter exists for staging, internal tools,
 * and early launches on Cloudflare's free tier with zero third parties.
 *
 * TTL: values carry `e` (expiresAtMs) so pttl/ttl keep working; when the
 * backing store supports `expiration`, the same TTL is passed to the KV
 * server so expired entries are actually collected.
 */

import type { StorageClient } from './types';

/** Minimal KV surface — Workers `KVNamespace`, our REST client, or the
 *  in-memory store used for tests/local dev. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor: string;
  }>;
}

type Envelope = {
  v: unknown;
  e: number | null;
  t: 'string' | 'number' | 'hash' | 'list' | 'set' | 'zset';
};

function encode(env: Envelope): string {
  return JSON.stringify(env);
}

function decode(raw: string | null): Envelope | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (!parsed || typeof parsed !== 'object' || !('v' in parsed)) return null;
    const type = parsed.t && ['string', 'number', 'hash', 'list', 'set', 'zset'].includes(parsed.t) ? parsed.t : 'string';
    return { v: parsed.v, e: typeof parsed.e === 'number' ? parsed.e : null, t: type };
  } catch {
    return { v: raw, e: null, t: 'string' }; // plain string written outside the adapter
  }
}

function normalizeIndex(index: number, length: number): number {
  return index < 0 ? length + index : index;
}

function isExpired(env: Envelope, now = Date.now()): boolean {
  return env.e !== null && env.e <= now;
}

export class CloudflareKvStorageClient implements StorageClient {
  private kv: KvStore;

  constructor(kv: KvStore) {
    this.kv = kv;
  }

  private async read(key: string): Promise<Envelope | null> {
    const raw = await this.kv.get(key);
    const env = decode(raw);
    if (!env) return null;
    if (isExpired(env)) {
      await this.kv.delete(key).catch(() => {});
      return null;
    }
    return env;
  }

  private async write(key: string, env: Envelope): Promise<void> {
    const ttlSeconds = env.e ? Math.max(1, Math.ceil((env.e - Date.now()) / 1000)) : undefined;
    await this.kv.put(key, encode(env), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  }

  private async mutate(key: string, fn: (env: Envelope | null) => Envelope | null): Promise<Envelope | null> {
    const current = await this.read(key);
    const next = fn(current);
    if (!next) {
      await this.kv.delete(key).catch(() => {});
      return null;
    }
    await this.write(key, next);
    return next;
  }

  async ping(): Promise<unknown> {
    return 'PONG';
  }

  async get(key: string): Promise<unknown> {
    const env = await this.read(key);
    if (!env) return null;
    return env.t === 'number' ? Number(env.v) : env.v;
  }

  async set(key: string, value: string | number | unknown): Promise<unknown> {
    const isNumber = typeof value === 'number' && Number.isFinite(value);
    const stored = isNumber ? (value as number) : typeof value === 'string' ? (value as string) : JSON.stringify(value ?? null);
    await this.write(key, { v: stored, e: null, t: isNumber ? 'number' : 'string' });
    return 'OK';
  }

  async setex(key: string, seconds: number, value: string): Promise<unknown> {
    await this.write(key, { v: value, e: Date.now() + Math.max(1, seconds) * 1000, t: 'string' });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      const exists = await this.read(key);
      if (exists) {
        await this.kv.delete(key).catch(() => {});
        removed++;
      }
    }
    return removed;
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (await this.read(key)) count++;
    }
    return count;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const env = await this.read(key);
    if (!env) return 0;
    env.e = Date.now() + Math.max(1, seconds) * 1000;
    await this.write(key, env);
    return 1;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const env = await this.read(key);
    if (!env) return 0;
    env.e = Date.now() + Math.max(1, ms);
    await this.write(key, env);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const env = await this.read(key);
    if (!env) return -2;
    if (env.e === null) return -1;
    return Math.max(0, Math.ceil((env.e - Date.now()) / 1000));
  }

  async pttl(key: string): Promise<number> {
    const env = await this.read(key);
    if (!env) return -2;
    if (env.e === null) return -1;
    return Math.max(0, env.e - Date.now());
  }

  async incr(key: string): Promise<number> {
    return this.incrby(key, 1);
  }

  async incrby(key: string, by: number): Promise<number> {
    const current = await this.read(key);
    const base = current && current.t === 'number' ? Number(current.v) || 0 : 0;
    const next = base + by;
    await this.write(key, { v: next, e: current?.e ?? null, t: 'number' });
    return next;
  }

  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.indexOf('*') >= 0 ? pattern.slice(0, pattern.indexOf('*')) : pattern;
    const all: string[] = [];
    let cursor = '';
    for (;;) {
      const page = await this.kv.list({ prefix, limit: 1000, cursor: cursor || undefined });
      for (const k of page.keys) all.push(k.name);
      if (page.list_complete || !page.cursor) break;
      cursor = page.cursor;
    }
    if (pattern.indexOf('*') < 0) return all.filter((k) => k === pattern);
    return all;
  }

  async type(key: string): Promise<string> {
    const env = await this.read(key);
    if (!env) return 'none';
    return env.t;
  }

  async renamenx(oldKey: string, newKey: string): Promise<number> {
    if (oldKey === newKey) return 0;
    const source = await this.read(oldKey);
    if (!source) return 0;
    const target = await this.read(newKey);
    if (target) return 0;
    await this.write(newKey, source);
    await this.kv.delete(oldKey).catch(() => {});
    return 1;
  }

  async hset(key: string, data: Record<string, string | number>): Promise<number> {
    await this.mutate(key, (current) => {
      const hash = current && current.t === 'hash' && current.v && typeof current.v === 'object' ? { ...(current.v as Record<string, string>) } : {};
      for (const [field, value] of Object.entries(data || {})) hash[field] = String(value);
      return { v: hash, e: current?.e ?? null, t: 'hash' as const };
    });
    return Object.keys(data || {}).length;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const env = await this.read(key);
    if (!env || env.t !== 'hash' || !env.v || typeof env.v !== 'object') return null;
    const value = (env.v as Record<string, string>)[field];
    return value === undefined ? null : String(value);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const env = await this.read(key);
    if (!env || env.t !== 'hash' || !env.v || typeof env.v !== 'object') return null;
    return env.v as Record<string, string>;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    let removed = 0;
    await this.mutate(key, (current) => {
      if (!current || current.t !== 'hash' || !current.v || typeof current.v !== 'object') return current;
      const hash = { ...(current.v as Record<string, string>) };
      for (const field of fields) {
        if (field in hash) {
          delete hash[field];
          removed++;
        }
      }
      return { v: hash, e: current.e, t: 'hash' as const };
    });
    return removed;
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    let result = 0;
    await this.mutate(key, (current) => {
      const hash = current && current.t === 'hash' && current.v && typeof current.v === 'object' ? { ...(current.v as Record<string, string>) } : {};
      const base = Number(hash[field]) || 0;
      result = base + by;
      hash[field] = String(result);
      return { v: hash, e: current?.e ?? null, t: 'hash' as const };
    });
    return result;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const env = await this.read(key);
    const list = env && env.t === 'list' && Array.isArray(env.v) ? (env.v as string[]) : [];
    const len = list.length;
    const s = normalizeIndex(start, len);
    const e = normalizeIndex(stop, len);
    if (s >= len || s > e) return [];
    return list.slice(Math.max(0, s), Math.min(len, e + 1));
  }

  async lset(key: string, index: number, value: string): Promise<unknown> {
    await this.mutate(key, (current) => {
      if (!current || current.t !== 'list' || !Array.isArray(current.v)) throw new Error('no such key');
      const list = [...(current.v as string[])];
      const i = normalizeIndex(index, list.length);
      if (i < 0 || i >= list.length) throw new Error('index out of range');
      list[i] = value;
      return { v: list, e: current.e, t: 'list' as const };
    });
    return 'OK';
  }

  async llen(key: string): Promise<number> {
    const env = await this.read(key);
    return env && env.t === 'list' && Array.isArray(env.v) ? (env.v as string[]).length : 0;
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    await this.mutate(key, (current) => {
      if (!current || current.t !== 'list' || !Array.isArray(current.v)) return null;
      const list = current.v as string[];
      const len = list.length;
      const s = normalizeIndex(start, len);
      const e = normalizeIndex(stop, len);
      if (s >= len || s > e) return null;
      return { v: list.slice(Math.max(0, s), Math.min(len, e + 1)), e: current.e, t: 'list' as const };
    });
    return 'OK';
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    let removed = 0;
    await this.mutate(key, (current) => {
      if (!current || current.t !== 'list' || !Array.isArray(current.v)) return current;
      const list = [...(current.v as string[])];
      const next: string[] = [];
      const wanted = Math.abs(count);
      if (count >= 0) {
        for (const item of list) {
          if (removed < wanted && item === value) removed++;
          else next.push(item);
        }
      } else {
        const reversed = [...list].reverse();
        const keptReversed: string[] = [];
        for (const item of reversed) {
          if (removed < wanted && item === value) removed++;
          else keptReversed.push(item);
        }
        next.push(...keptReversed.reverse());
      }
      return { v: next, e: current.e, t: 'list' as const };
    });
    return removed;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    let length = 0;
    await this.mutate(key, (current) => {
      const list = current && current.t === 'list' && Array.isArray(current.v) ? [...(current.v as string[])] : [];
      list.push(...values);
      length = list.length;
      return { v: list, e: current?.e ?? null, t: 'list' as const };
    });
    return length;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let added = 0;
    await this.mutate(key, (current) => {
      const set = current && current.t === 'set' && Array.isArray(current.v) ? new Set(current.v as string[]) : new Set<string>();
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          added++;
        }
      }
      return { v: [...set], e: current?.e ?? null, t: 'set' as const };
    });
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    let removed = 0;
    await this.mutate(key, (current) => {
      if (!current || current.t !== 'set' || !Array.isArray(current.v)) return current;
      const set = new Set(current.v as string[]);
      for (const member of members) {
        if (set.delete(member)) removed++;
      }
      return { v: [...set], e: current.e, t: 'set' as const };
    });
    return removed;
  }

  async sismember(key: string, member: string): Promise<number> {
    const env = await this.read(key);
    if (!env || env.t !== 'set' || !Array.isArray(env.v)) return 0;
    return (env.v as string[]).includes(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    const env = await this.read(key);
    if (!env || env.t !== 'set' || !Array.isArray(env.v)) return [];
    return env.v as string[];
  }

  async zadd(key: string, entry: { score: number; member: string }): Promise<number> {
    let added = 0;
    await this.mutate(key, (current) => {
      const entries =
        current && current.t === 'zset' && Array.isArray(current.v)
          ? [...(current.v as { m: string; s: number }[])]
          : [];
      const existing = entries.findIndex((e) => e.m === entry.member);
      if (existing < 0) added = 1;
      if (existing >= 0) entries[existing] = { m: entry.member, s: entry.score };
      else entries.push({ m: entry.member, s: entry.score });
      entries.sort((a, b) => a.s - b.s || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));
      return { v: entries, e: current?.e ?? null, t: 'zset' as const };
    });
    return added;
  }

  async zrange(
    key: string,
    start: number,
    stop: number,
    opts?: { withScores?: boolean },
  ): Promise<Array<string | number>> {
    const env = await this.read(key);
    const entries =
      env && env.t === 'zset' && Array.isArray(env.v) ? (env.v as { m: string; s: number }[]) : [];
    const len = entries.length;
    const s = normalizeIndex(start, len);
    const e = normalizeIndex(stop, len);
    const slice = s >= len || s > e ? [] : entries.slice(Math.max(0, s), Math.min(len, e + 1));
    if (opts?.withScores) {
      const out: Array<string | number> = [];
      for (const item of slice) out.push(item.m, item.s);
      return out;
    }
    return slice.map((item) => item.m);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    let removed = 0;
    await this.mutate(key, (current) => {
      if (!current || current.t !== 'zset' || !Array.isArray(current.v)) return current;
      const kept: { m: string; s: number }[] = [];
      for (const item of current.v as { m: string; s: number }[]) {
        if (item.s >= min && item.s <= max) removed++;
        else kept.push(item);
      }
      return { v: kept, e: current.e, t: 'zset' as const };
    });
    return removed;
  }

  async zcard(key: string): Promise<number> {
    const env = await this.read(key);
    return env && env.t === 'zset' && Array.isArray(env.v) ? (env.v as { m: string; s: number }[]).length : 0;
  }
}

/**
 * ── In-memory KV store (local dev / tests) ─────────────────────────────────
 * Workers KV has no local Node implementation, so when no real binding is
 * provided the adapter falls back to a process-scoped in-memory store. That
 * makes `STORAGE_PROVIDER=cloudflare-kv` runnable on a plain `npm run dev`
 * box and inside `node --test` — but data does NOT survive a process restart.
 * On a real Workers deploy, hand the factory the actual KV namespace (or let
 * it auto-detect a KV-shaped global binding) so data is durable and shared
 * across isolates.
 */
class InMemoryKvStore implements KvStore {
  private map = new Map<string, { value: string; expiration?: number }>();

  async get(key: string): Promise<string | null> {
    const rec = this.map.get(key);
    if (!rec) return null;
    if (rec.expiration && rec.expiration <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return rec.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    let expiration: number | undefined;
    if (options?.expiration) expiration = options.expiration;
    else if (options?.expirationTtl) expiration = Date.now() + options.expirationTtl * 1000;
    this.map.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor: string;
  }> {
    const prefix = options?.prefix || '';
    const limit = options?.limit || 1000;
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const cursor = options?.cursor || '';
    let startIndex = 0;
    if (cursor) {
      const parsed = Number(cursor.split('|')[1] ?? 0);
      startIndex = Number.isFinite(parsed) ? parsed : 0;
    }
    const slice = all.slice(startIndex, startIndex + limit);
    const list_complete = startIndex + slice.length >= all.length;
    const nextCursor = list_complete ? '' : `${slice[slice.length - 1]}|${startIndex + slice.length}`;
    return { keys: slice.map((name) => ({ name })), list_complete, cursor: nextCursor };
  }
}

/** Look for a KV-namespace-shaped binding on `globalThis` (OpenNext Workers
 *  wrappers and `nodejs_compat` runtimes surface bindings there). Any global
 *  value that implements get/put/delete/list is treated as a KV store. */
function detectWorkersKvBinding(): KvStore | null {
  try {
    const g = globalThis as Record<string, unknown>;
    const looksLikeKv = (v: unknown): v is KvStore =>
      !!v &&
      typeof (v as KvStore).get === 'function' &&
      typeof (v as KvStore).put === 'function' &&
      typeof (v as KvStore).delete === 'function' &&
      typeof (v as KvStore).list === 'function';
    const named = ['STORE_KV', 'GOYUNIR_KV', 'ALLOCATION_KV', 'KV'];
    for (const name of named) {
      if (looksLikeKv(g[name])) return g[name] as KvStore;
    }
    for (const key of Object.keys(g)) {
      if (!/^[A-Z_]+$/.test(key) || !/KV/i.test(key)) continue;
      if (looksLikeKv(g[key])) return g[key] as KvStore;
    }
  } catch {
    /* no binding */
  }
  return null;
}

/**
 * Create the Workers-KV-backed StorageClient.
 *
 *   - `kv` provided   → wrap the caller's KV store (e.g. the Cloudflare
 *                       binding resolved by the deployment layer).
 *   - KV-shaped global→ auto-detected binding (Workers/OpenNext runtimes).
 *   - otherwise       → in-memory store (local dev / tests only; data is
 *                       process-scoped and lost on restart).
 *
 * Never returns null — the app can always reach a store, even an ephemeral one.
 */
export function createCloudflareKvClient(kv?: KvStore): StorageClient {
  const store = kv ?? detectWorkersKvBinding() ?? new InMemoryKvStore();
  return new CloudflareKvStorageClient(store);
}