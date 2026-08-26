import type { StorageClient } from './types';

/**
 * REPLICATED STORAGE — write-through mirroring + read failover.
 *
 * Protects against DATA LOSS (the single worst failure for a store that has
 * held customer accounts, entries, ledgers and orders for years) by mirroring
 * every write to one or more INDEPENDENT data stores. The primary is
 * canonical — its errors propagate (so a caller always knows whether the
 * source-of-truth accepted a write) — while replica writes are best-effort:
 * a downed replica never breaks the store.
 *
 * Reads prefer the primary; if the primary throws OR returns an empty result
 * (a clear "not here" signal), the client transparently fails over to the
 * replicas in order. This keeps the store readable even when the primary
 * vendor has an outage.
 *
 * ⚠️ This is write-through REPLICATION (protects against a vendor losing data),
 * not multi-master HA. The primary is always the authority; replicas are
 * mirrors. Promoting a replica to primary is an operator decision (change
 * STORAGE_PROVIDER), not automatic — automatic failover across vendors would
 * be unsafe with last-write-wins semantics.
 */
export class ReplicatedStorageClient implements StorageClient {
  private readonly primary: StorageClient;
  private readonly replicas: StorageClient[];

  constructor(primary: StorageClient, replicas: StorageClient[]) {
    this.primary = primary;
    this.replicas = replicas;
  }

  /** Writes: primary is canonical (errors throw); replicas are best-effort. */
  private async write<T>(op: (client: StorageClient) => Promise<T>): Promise<T> {
    const result = await op(this.primary);
    for (const replica of this.replicas) {
      op(replica).catch(() => {
        /* a downed mirror must never break a write */
      });
    }
    return result;
  }

  /** Reads: primary first, then replicas on throw or empty result. */
  private async read<T>(op: (client: StorageClient) => Promise<T>, isEmpty: (value: T) => boolean): Promise<T> {
    try {
      const value = await op(this.primary);
      if (!isEmpty(value)) return value;
    } catch {
      /* primary failed — try the mirrors */
    }
    for (const replica of this.replicas) {
      try {
        const value = await op(replica);
        if (!isEmpty(value)) return value;
      } catch {
        /* keep trying the next mirror */
      }
    }
    try {
      return await op(this.primary);
    } catch {
      return undefined as unknown as T;
    }
  }

  ping(): Promise<unknown> {
    return this.read((c) => c.ping(), () => false);
  }

  get(key: string): Promise<unknown> {
    return this.read((c) => c.get(key), (v) => v == null);
  }

  set(key: string, value: string | number | unknown): Promise<unknown> {
    return this.write((c) => c.set(key, value));
  }

  setex(key: string, seconds: number, value: string): Promise<unknown> {
    return this.write((c) => c.setex(key, seconds, value));
  }

  del(...keys: string[]): Promise<number> {
    return this.write((c) => c.del(...keys));
  }

  exists(...keys: string[]): Promise<number> {
    return this.read((c) => c.exists(...keys), (v) => v === 0);
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.write((c) => c.expire(key, seconds));
  }

  pexpire(key: string, ms: number): Promise<number> {
    return this.write((c) => c.pexpire(key, ms));
  }

  ttl(key: string): Promise<number> {
    return this.read((c) => c.ttl(key), (v) => v === -2);
  }

  pttl(key: string): Promise<number> {
    return this.read((c) => c.pttl(key), (v) => v === -2);
  }

  incr(key: string): Promise<number> {
    return this.write((c) => c.incr(key));
  }

  incrby(key: string, by: number): Promise<number> {
    return this.write((c) => c.incrby(key, by));
  }

  keys(pattern: string): Promise<string[]> {
    return this.read((c) => c.keys(pattern), (v) => v.length === 0);
  }

  type(key: string): Promise<string> {
    return this.read((c) => c.type(key), (v) => v === 'none');
  }

  renamenx(oldKey: string, newKey: string): Promise<number> {
    return this.write((c) => c.renamenx(oldKey, newKey));
  }

  hset(key: string, data: Record<string, string | number>): Promise<number> {
    return this.write((c) => c.hset(key, data));
  }

  hget(key: string, field: string): Promise<string | null> {
    return this.read((c) => c.hget(key, field), (v) => v == null);
  }

  hgetall(key: string): Promise<Record<string, string> | null> {
    return this.read((c) => c.hgetall(key), (v) => v == null || Object.keys(v).length === 0);
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    return this.write((c) => c.hdel(key, ...fields));
  }

  hincrby(key: string, field: string, by: number): Promise<number> {
    return this.write((c) => c.hincrby(key, field, by));
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.read((c) => c.lrange(key, start, stop), (v) => v.length === 0);
  }

  lset(key: string, index: number, value: string): Promise<unknown> {
    return this.write((c) => c.lset(key, index, value));
  }

  llen(key: string): Promise<number> {
    return this.read((c) => c.llen(key), (v) => v === 0);
  }

  ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return this.write((c) => c.ltrim(key, start, stop));
  }

  lrem(key: string, count: number, value: string): Promise<number> {
    return this.write((c) => c.lrem(key, count, value));
  }

  rpush(key: string, ...values: string[]): Promise<number> {
    return this.write((c) => c.rpush(key, ...values));
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    return this.write((c) => c.sadd(key, ...members));
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.write((c) => c.srem(key, ...members));
  }

  sismember(key: string, member: string): Promise<number> {
    return this.read((c) => c.sismember(key, member), (v) => v === 0);
  }

  smembers(key: string): Promise<string[]> {
    return this.read((c) => c.smembers(key), (v) => v.length === 0);
  }

  zadd(key: string, entry: { score: number; member: string }): Promise<number> {
    return this.write((c) => c.zadd(key, entry));
  }

  zrange(
    key: string,
    start: number,
    stop: number,
    opts?: { withScores?: boolean },
  ): Promise<Array<string | number>> {
    return this.read((c) => c.zrange(key, start, stop, opts), (v) => v.length === 0);
  }

  zscore(key: string, member: string): Promise<number | null> {
    return this.read((c) => c.zscore(key, member), (v) => v == null);
  }

  zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    return this.write((c) => c.zremrangebyscore(key, min, max));
  }

  zcard(key: string): Promise<number> {
    return this.read((c) => c.zcard(key), (v) => v === 0);
  }
}
