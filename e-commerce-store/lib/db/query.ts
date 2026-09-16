/**
 * STRUCTURED QUERY SPEC -> PostgREST. Pure, zero-import (see tests/db-query.test.ts).
 *
 * Why this exists: lib/adapters/db.ts already wraps the HTTP transport, but its
 * `query` parameter is a raw PostgREST string — `"tenant_id=eq.X&select=id&limit=1"`.
 * That leaks Supabase's query dialect through the abstraction, so swapping
 * backends would still mean rewriting every call site. Wrapping the transport
 * without wrapping the dialect is a facade, not a port.
 *
 * Callers describe WHAT they want; this module renders it for the active
 * backend. A different backend implements a different renderer from the same
 * spec, and no business-logic file changes.
 *
 * It also centralises value encoding. PostgREST treats , . ( ) : and " as
 * syntax, so a value containing any of them must be double-quoted or it
 * silently changes the query's meaning — an email with a comma in a
 * `in.(...)` list would split into two filter values. Hand-built strings got
 * this right only by accident; here it is one tested function.
 */

export type FilterOp =
  | { op: 'eq'; value: string | number | boolean | null }
  | { op: 'neq'; value: string | number | boolean | null }
  | { op: 'gt'; value: string | number }
  | { op: 'gte'; value: string | number }
  | { op: 'lt'; value: string | number }
  | { op: 'lte'; value: string | number }
  | { op: 'like'; value: string }
  | { op: 'in'; values: Array<string | number> }
  | { op: 'is'; value: null | boolean };

export const eq = (value: string | number | boolean | null): FilterOp => ({ op: 'eq', value });
export const neq = (value: string | number | boolean | null): FilterOp => ({ op: 'neq', value });
export const gt = (value: string | number): FilterOp => ({ op: 'gt', value });
export const gte = (value: string | number): FilterOp => ({ op: 'gte', value });
export const lt = (value: string | number): FilterOp => ({ op: 'lt', value });
export const lte = (value: string | number): FilterOp => ({ op: 'lte', value });
export const like = (value: string): FilterOp => ({ op: 'like', value });
export const inList = (values: Array<string | number>): FilterOp => ({ op: 'in', values });
export const isNull = (): FilterOp => ({ op: 'is', value: null });

/**
 * A selected column, or an embedded relation with its own columns.
 *
 * Embeds are kept STRUCTURED rather than accepted as a raw
 * "rel(a,b)" string: PostgREST spells this as a nested select, another
 * backend would spell it as a join, and the point of the port is that the
 * call site states the intent and the renderer owns the dialect.
 */
export type SelectItem = string | { relation: string; columns: SelectItem[] };

export interface QuerySpec {
  where?: Record<string, FilterOp>;
  select?: SelectItem[];
  order?: { column: string; ascending?: boolean };
  limit?: number;
  offset?: number;
}

/**
 * Characters PostgREST parses as syntax inside a filter value.
 *
 * A '.' is deliberately NOT here. Only the FIRST dot separates the operator
 * from the value, so dots inside a value are ordinary characters. Treating
 * them as reserved quoted every email and dotted id, which changed the
 * request bytes against the pre-port code for no benefit.
 */
const RESERVED = /[,()":\s]/;

/**
 * Render one value. Reserved characters force double-quoting, and embedded
 * quotes/backslashes are escaped, so a value can never break out of its slot.
 */
export function encodeFilterValue(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  if (s === '') return '""';
  // A STRING that reads as a PostgREST literal must be quoted or it changes
  // meaning: eq.null matches SQL NULL, not the text 'null'. Booleans and
  // null passed as real types are handled above and stay unquoted.
  if (/^(null|true|false)$/i.test(s)) return `"${s}"`;
  if (RESERVED.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return s;
}

/** Reject identifiers that are not plain column names — never interpolate blindly. */
function assertIdentifier(name: string, what: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Percent-encode a rendered value token for the URL query string.
 *
 * Double-quoting alone is NOT enough. PostgREST's quoting protects its own
 * filter grammar, but the query string is split on '&' and '=' by the URL
 * layer FIRST — so a value containing '&' would start a new filter clause
 * before PostgREST ever sees the quotes. Verified: eq."x&role=eq.admin"
 * parsed as two clauses. Each value is encoded individually so the structural
 * commas inside in.(...) stay literal.
 */
function urlEncodeValue(token: string): string {
  return encodeURIComponent(token);
}

function renderFilter(filter: FilterOp): string {
  switch (filter.op) {
    case 'in':
      return `in.(${filter.values.map((v) => urlEncodeValue(encodeFilterValue(v))).join(',')})`;
    case 'is':
      return `is.${filter.value === null ? 'null' : String(filter.value)}`;
    default:
      return `${filter.op}.${urlEncodeValue(encodeFilterValue(filter.value))}`;
  }
}

/** Render one select item, recursing into embedded relations. */
function renderSelectItem(item: SelectItem): string {
  // '*' is PostgREST's select-everything wildcard and the one non-identifier
  // a select list may legitimately contain.
  if (item === '*') return '*';
  if (typeof item === 'string') return assertIdentifier(item, 'select column');
  const relation = assertIdentifier(item.relation, 'embedded relation');
  if (!Array.isArray(item.columns) || item.columns.length === 0) {
    throw new Error(`Embedded relation "${relation}" needs at least one column`);
  }
  return `${relation}(${item.columns.map(renderSelectItem).join(',')})`;
}

/**
 * Render a spec as a PostgREST query string WITHOUT the leading '?'.
 * Deterministic key order, so the same spec always produces the same string
 * (cacheable, and diffable in tests).
 */
export function buildPostgrestQuery(spec: QuerySpec = {}): string {
  const parts: string[] = [];
  for (const [column, filter] of Object.entries(spec.where || {})) {
    parts.push(`${assertIdentifier(column, 'filter column')}=${renderFilter(filter)}`);
  }
  if (spec.select && spec.select.length > 0) {
    parts.push(`select=${spec.select.map(renderSelectItem).join(',')}`);
  }
  if (spec.order) {
    const dir = spec.order.ascending === false ? '.desc' : '.asc';
    parts.push(`order=${assertIdentifier(spec.order.column, 'order column')}${dir}`);
  }
  if (typeof spec.limit === 'number') {
    if (!Number.isInteger(spec.limit) || spec.limit < 0) throw new Error(`Invalid limit: ${spec.limit}`);
    parts.push(`limit=${spec.limit}`);
  }
  if (typeof spec.offset === 'number') {
    if (!Number.isInteger(spec.offset) || spec.offset < 0) throw new Error(`Invalid offset: ${spec.offset}`);
    parts.push(`offset=${spec.offset}`);
  }
  return parts.join('&');
}
