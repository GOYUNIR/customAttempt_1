/**
 * ADAPTERS / DB — a provider-agnostic facade over Postgres access.
 *
 * Every current call site (`lib/inventory.ts`, `lib/orders.ts`, `lib/raffle.ts`,
 * `lib/tenant-context.ts`, …) talks to Supabase by calling `supabaseRestFetch`
 * (PostgREST over plain `fetch`) directly. This file does not re-implement that
 * HTTP layer — it wraps it behind `DbAdapter`, a small table-oriented interface
 * (select/insert/update/remove), so a future swap to another Postgres-compatible
 * backend (Neon, PlanetScale, AWS Aurora — anything fronted by PostgREST or an
 * equivalent REST data API) means implementing `DbAdapter` once, not touching
 * every call site that currently imports `services/config/supabase-client`
 * directly.
 *
 * Zero `@/` imports — relative only — so `node --test` can load this directly
 * (mirrors `services/config/supabase-client.ts`'s own edge-safe design).
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '../../services/config/supabase-client.ts';

export interface DbAdapter {
  /** Whether this adapter has the credentials it needs to reach the database. */
  readonly configured: boolean;
  /** `query` is a PostgREST-style query string without the leading `?`
   *  (e.g. `"tenant_id=eq.<id>&select=id,name&limit=1"`). */
  select<T = Record<string, unknown>>(table: string, query?: string): Promise<T[]>;
  insert<T = Record<string, unknown>>(table: string, rows: object | object[]): Promise<T[]>;
  update<T = Record<string, unknown>>(table: string, query: string, patch: object): Promise<T[]>;
  remove(table: string, query: string): Promise<void>;
}

class SupabaseDbAdapter implements DbAdapter {
  get configured(): boolean {
    return supabaseServiceConfigured();
  }

  private async key(): Promise<string> {
    const { serviceRoleKey } = readSupabaseEnv();
    if (!serviceRoleKey) throw new Error('DbAdapter: Supabase is not configured (SUPABASE_SERVICE_ROLE_KEY missing).');
    return serviceRoleKey;
  }

  async select<T = Record<string, unknown>>(table: string, query?: string): Promise<T[]> {
    const key = await this.key();
    const rows = await supabaseRestFetch(`/${table}${query ? `?${query}` : ''}`, { key, method: 'GET' });
    return (rows as T[]) ?? [];
  }

  async insert<T = Record<string, unknown>>(table: string, rows: object | object[]): Promise<T[]> {
    const key = await this.key();
    const result = await supabaseRestFetch(`/${table}`, { key, method: 'POST', body: rows, prefer: 'return=representation' });
    return (result as T[]) ?? [];
  }

  async update<T = Record<string, unknown>>(table: string, query: string, patch: object): Promise<T[]> {
    const key = await this.key();
    const result = await supabaseRestFetch(`/${table}?${query}`, { key, method: 'PATCH', body: patch, prefer: 'return=representation' });
    return (result as T[]) ?? [];
  }

  async remove(table: string, query: string): Promise<void> {
    const key = await this.key();
    await supabaseRestFetch(`/${table}?${query}`, { key, method: 'DELETE' });
  }
}

/** The active DB adapter. Today this always resolves to the Supabase-backed
 *  implementation — swapping providers later means adding a second
 *  implementation of `DbAdapter` and choosing between them here, the same
 *  `registry`/`factory` shape `services/{payment,email,maps}/` already use. */
export function getDbAdapter(): DbAdapter {
  return new SupabaseDbAdapter();
}
