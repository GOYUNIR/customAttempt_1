/**
 * DbClient — the database PORT.
 *
 * Business logic states WHAT it wants (table + structured QuerySpec) and never
 * writes PostgREST syntax. Swapping Postgres backends means implementing this
 * interface once against the new backend's dialect; no call site changes.
 *
 * This supersedes lib/adapters/db.ts, whose `query` parameter was a raw
 * PostgREST string — that wrapped the transport while leaking the dialect, so
 * it could never have delivered portability (see ARCHITECTURE.md, Phase D).
 *
 * Relative imports with explicit .ts extensions, so `node --test` can load this
 * without the `@/` alias resolution it does not support.
 */
import { buildPostgrestQuery, type QuerySpec } from './query.ts';
import {
  supabaseServiceConfigured,
  readSupabaseEnv,
  supabaseRestFetch,
} from '../../services/config/supabase-client.ts';

/** Which timeout/retry budget a call runs under (see lib/db-timeout-policy.ts). */
export type DbTier = 'interactive' | 'background';

export interface DbCallOptions {
  /** 'interactive' (default) fails fast; 'background' is patient. */
  tier?: DbTier;
}

/**
 * What to ask for back from a write.
 *   'representation' — return the written rows (the port default)
 *   'minimal'        — explicitly ask for nothing back
 *   'default'        — send NO return directive and let PostgREST decide
 *
 * 'default' exists so a migrated call site can reproduce legacy behaviour
 * byte-for-byte: several pre-port callers sent no Prefer return directive at
 * all, and silently switching them to an explicit one would change the request
 * (and the response size) during a refactor that is supposed to change neither.
 */
export type ReturningMode = 'representation' | 'minimal' | 'default';

export interface WriteOptions extends DbCallOptions {
  returning?: ReturningMode;
}

export interface InsertOptions extends WriteOptions {
  /** Column list for upsert conflict resolution, e.g. 'tenant_id,variant_id'. */
  onConflict?: string;
  /** Send `resolution=merge-duplicates` without an on_conflict query param. */
  mergeDuplicates?: boolean;
}

/** Build the Prefer header value, or undefined to send none at all. */
function preferHeader(returning: ReturningMode, merge: boolean): string | undefined {
  const parts: string[] = [];
  if (returning !== 'default') parts.push(`return=${returning}`);
  if (merge) parts.push('resolution=merge-duplicates');
  return parts.length > 0 ? parts.join(',') : undefined;
}

export interface DbClient {
  /** Whether credentials to reach the database are present. */
  readonly configured: boolean;
  select<T = Record<string, unknown>>(table: string, spec?: QuerySpec, opts?: DbCallOptions): Promise<T[]>;
  insert<T = Record<string, unknown>>(table: string, rows: object | object[], opts?: InsertOptions): Promise<T[]>;
  update<T = Record<string, unknown>>(table: string, spec: QuerySpec, patch: object, opts?: WriteOptions): Promise<T[]>;
  remove(table: string, spec: QuerySpec, opts?: DbCallOptions): Promise<void>;
}

/** Table names are interpolated into a URL path — validate, never trust. */
function assertTable(table: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table name: ${JSON.stringify(table)}`);
  }
  return table;
}

/**
 * A write with no filter would hit every row in the table. PostgREST will
 * happily do that. Require at least one condition on update/remove.
 */
function assertScoped(spec: QuerySpec, op: string): void {
  if (!spec || !spec.where || Object.keys(spec.where).length === 0) {
    throw new Error(`Refusing unscoped ${op}: a where clause is required (it would affect every row).`);
  }
}

class SupabaseDbClient implements DbClient {
  get configured(): boolean {
    return supabaseServiceConfigured();
  }

  private key(): string {
    const { serviceRoleKey } = readSupabaseEnv();
    if (!serviceRoleKey) {
      throw new Error('DbClient: Supabase is not configured (SUPABASE_SERVICE_ROLE_KEY missing).');
    }
    return serviceRoleKey;
  }

  async select<T = Record<string, unknown>>(table: string, spec: QuerySpec = {}, opts: DbCallOptions = {}): Promise<T[]> {
    const query = buildPostgrestQuery(spec);
    const path = `/${assertTable(table)}${query ? `?${query}` : ''}`;
    const rows = await supabaseRestFetch(path, { key: this.key(), method: 'GET', tier: opts.tier });
    return (rows as T[]) ?? [];
  }

  async insert<T = Record<string, unknown>>(table: string, rows: object | object[], opts: InsertOptions = {}): Promise<T[]> {
    // Encode each COLUMN, not the whole list: the commas in
    // "tenant_id,email" are PostgREST's separators. Running the list through
    // encodeURIComponent turned them into %2C — which PostgREST still decodes,
    // but it needlessly differs from the pre-port request.
    const conflict = opts.onConflict
      ? `?on_conflict=${opts.onConflict.split(',').map((c) => encodeURIComponent(c.trim())).join(',')}`
      : '';
    const prefer = preferHeader(
      opts.returning ?? 'representation',
      Boolean(opts.onConflict || opts.mergeDuplicates),
    );
    const result = await supabaseRestFetch(`/${assertTable(table)}${conflict}`, {
      key: this.key(),
      method: 'POST',
      body: rows,
      prefer,
      tier: opts.tier,
    });
    return (result as T[]) ?? [];
  }

  async update<T = Record<string, unknown>>(table: string, spec: QuerySpec, patch: object, opts: WriteOptions = {}): Promise<T[]> {
    assertScoped(spec, 'update');
    const result = await supabaseRestFetch(`/${assertTable(table)}?${buildPostgrestQuery(spec)}`, {
      key: this.key(),
      method: 'PATCH',
      body: patch,
      prefer: preferHeader(opts.returning ?? 'representation', false),
      tier: opts.tier,
    });
    return (result as T[]) ?? [];
  }

  async remove(table: string, spec: QuerySpec, opts: DbCallOptions = {}): Promise<void> {
    assertScoped(spec, 'delete');
    await supabaseRestFetch(`/${assertTable(table)}?${buildPostgrestQuery(spec)}`, {
      key: this.key(),
      method: 'DELETE',
      tier: opts.tier,
    });
  }
}

let cached: DbClient | null = null;

/** The active DbClient. Swapping backends means returning a different one here. */
export function getDb(): DbClient {
  if (!cached) cached = new SupabaseDbClient();
  return cached;
}

/** Test seam: inject a fake DbClient. Pass null to restore the real one. */
export function __setDbClientForTests(client: DbClient | null): void {
  cached = client;
}

export type { QuerySpec };
