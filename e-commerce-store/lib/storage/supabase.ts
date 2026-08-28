/**
 * SUPABASE STORAGE ADAPTER — implements the `StorageClient` contract on top of
 * a PostgREST `store_kv` table so Supabase can be the PRIMARY data store.
 *
 * This is the DEFAULT provider when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
 * are present (see `resolveStorageProvider()` in types.ts). It reuses the exact
 * same envelope encoding as the Workers-KV adapter (`CloudflareKvStorageClient`)
 * by wrapping a PostgREST-backed `KvStore` — every logical key is one `store_kv`
 * row whose `value` is `{ "v": <value>, "e": <expiresAtMs|null>, "t": <type> }`.
 *
 * ⚠️ SERVICE-ROLE KEY REQUIRED. `public.store_kv` has ROW LEVEL SECURITY enabled
 * (see supabase/migrations/00001_init.sql) and no anon/authenticated policy, so
 * the ANON key can neither read nor write it. The adapter therefore resolves
 * ONLY the service-role key — a Supabase project without a service-role key is
 * treated as "not configured" and the factory falls back to Upstash Redis. The
 * service-role key is used exclusively server-side and never shipped to a
 * browser.
 *
 * Credentials resolve through `readSupabaseEnv()` (services/config/supabase-client.ts)
 * so the SAME env aliases (`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`)
 * AND the Setup Wizard's inline runtime override (`setSupabaseRuntimeCredentials`)
 * are honored here — keeping the storage adapter in lock-step with the wizard and
 * the admin readiness gate. (Previously this file read `process.env` directly and
 * silently fell back to the anon key, so a wizard save with inline credentials
 * never activated Supabase storage, and an anon-only project read an empty KV.)
 *
 * CONCURRENCY CAVEATS — PostgREST has NO atomic counters, so collection mutations
 * are read-modify-write. SAFE: admin edits, config, product CRUD, settings,
 * seed/wipe, rate-limit bumps. RISKY: concurrent customer checkouts appending to
 * the same raffle pool (`rpush`) or the double-entry `sadd` guards — under a real
 * traffic spike entries can be lost. For production payment/raffle writes keep
 * Upstash Redis (set `STORAGE_PROVIDER=upstash`) which runs everywhere.
 */

import { CloudflareKvStorageClient, type KvStore } from './cloudflare-kv';
import type { StorageClient } from './types';
import { readSupabaseEnv } from '@/services/config/supabase-client';

function readSupabaseStorageEnv(): { url: string; key: string } {
  // Service-role key ONLY — `store_kv` RLS blocks the anon key (see header).
  const { url, serviceRoleKey } = readSupabaseEnv();
  return { url, key: serviceRoleKey };
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
    const res = await fetch(this.base(), {
      method: 'POST',
      headers: { ...this.headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, value, expires_at: expiresAt }),
    });
    // Surface write failures (bad key, RLS, missing schema) instead of silently
    // dropping data — admin saves / seed / wipe must never report success while
    // the underlying PostgREST write actually failed.
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase store_kv write failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(`${this.base()}?key=eq.${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    // A successful DELETE is 204 even when no row matched; anything else is a
    // real failure (bad key, RLS, missing schema). Note `del()` / `mutate()` in
    // cloudflare-kv.ts wrap `kv.delete` in `.catch(() => {})`, so this surfaces
    // only where it is genuinely actionable and never breaks fail-open paths.
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase store_kv delete failed (${res.status}): ${text.slice(0, 300)}`);
    }
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

/** Whether the Supabase storage adapter is configured (URL + service-role key). */
export function supabaseStorageConfigured(): boolean {
  const { url, key } = readSupabaseStorageEnv();
  return Boolean(url && key);
}

/**
 * SELF-HEAL — prune every expired `store_kv` row.
 *
 * The Supabase KV adapter lazily deletes an expired row when it is read, but a
 * row that is never read again would linger forever and slowly bloat the table.
 * This runs a single PostgREST DELETE against rows whose `expires_at` is in the
 * past, keeping a Supabase-backed datastore tidy with no operator action.
 * Returns true when the prune ran without throwing (PostgREST DELETE is 204 even
 * when no rows match, so a no-op is indistinguishable from a real prune — and
 * both are safe).
 */
export async function pruneExpiredSupabaseKv(): Promise<boolean> {
  const { url, key } = readSupabaseStorageEnv();
  if (!url || !key) return false;
  try {
    const res = await fetch(
      `${url}/rest/v1/store_kv?expires_at=lt.${encodeURIComponent(new Date().toISOString())}&select=key`,
      {
        method: 'DELETE',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        signal: AbortSignal.timeout(8000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
