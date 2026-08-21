/**
 * SUPABASE STORAGE ADAPTER — implements the `StorageClient` contract on top of
 * a PostgREST `store_kv` table so Supabase can be the PRIMARY data store.
 *
 * This is the DEFAULT provider when `SUPABASE_URL` + a key are present (see
 * `resolveStorageProvider()` in types.ts). It reuses the exact same envelope
 * encoding as the Workers-KV adapter (`CloudflareKvStorageClient`) by wrapping
 * a PostgREST-backed `KvStore` — every logical key is one `store_kv` row whose
 * `value` is `{ "v": <value>, "e": <expiresAtMs|null>, "t": <type> }`.
 *
 * CONCURRENCY CAVEATS — PostgREST (like Workers KV) has NO atomic counters, so
 * collection mutations are read-modify-write. SAFE: admin edits, config,
 * product CRUD, settings, seed/wipe, rate-limit bumps. RISKY: concurrent
 * customer checkouts appending to the same raffle pool (`rpush`) or the
 * double-entry `sadd` guards — under a real traffic spike entries can be lost.
 * For production payment/raffle writes keep Upstash Redis (set
 * `STORAGE_PROVIDER=upstash`) which runs everywhere.
 */

import { CloudflareKvStorageClient, type KvStore } from './cloudflare-kv';
import type { StorageClient } from './types';

function readSupabaseStorageEnv(): { url: string; key: string } {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  return { url, key };
}

/** Minimal PostgREST-backed KV store (get/put/delete/list). */
class SupabaseKvStore implements KvStore {
  private url: string;
  private key: string;

  constructor(url: string, key: string) {
    this.url = url;
    this.key = key;
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
    };
  }

  private base(): string {
    return `${this.url}/rest/v1/store_kv`;
  }

  async get(key: string): Promise<string | null> {
    const url = `${this.base()}?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`;
    const res = await fetch(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) return null;
    const rows = (await res.json().catch(() => [])) as Array<{ value?: string; expires_at?: string | null }>;
    const row = rows[0];
    if (!row || typeof row.value !== 'string') return null;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      await this.delete(key).catch(() => {});
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void> {
    let expiresAt: string | null = null;
    if (options?.expiration) expiresAt = new Date(options.expiration).toISOString();
    else if (options?.expirationTtl) expiresAt = new Date(Date.now() + options.expirationTtl * 1000).toISOString();
    await fetch(this.base(), {
      method: 'POST',
      headers: { ...this.headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value, expires_at: expiresAt }),
    });
  }

  async delete(key: string): Promise<void> {
    await fetch(`${this.base()}?key=eq.${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor: string;
  }> {
    const prefix = options?.prefix || '';
    const limit = options?.limit || 1000;
    const url = `${this.base()}?select=key&limit=${limit}${prefix ? `&key=like.${encodeURIComponent(prefix)}*` : ''}`;
    const res = await fetch(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) return { keys: [], list_complete: true, cursor: '' };
    const rows = (await res.json().catch(() => [])) as Array<{ key?: string }>;
    return { keys: rows.filter((r) => typeof r.key === 'string').map((r) => ({ name: r.key as string })), list_complete: true, cursor: '' };
  }
}

/** Create the Supabase-backed StorageClient, or null when Supabase is unset. */
export function createSupabaseClient(): StorageClient | null {
  const { url, key } = readSupabaseStorageEnv();
  if (!url || !key) return null;
  try {
    return new CloudflareKvStorageClient(new SupabaseKvStore(url, key));
  } catch {
    return null;
  }
}

/** Whether the Supabase storage adapter is configured (env present). */
export function supabaseStorageConfigured(): boolean {
  const { url, key } = readSupabaseStorageEnv();
  return Boolean(url && key);
}
