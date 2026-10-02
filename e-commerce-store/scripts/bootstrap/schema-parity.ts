/**
 * SCHEMA PARITY: does a live database have exactly the schema the migrations
 * build? Builds a fresh install in memory (pglite-install.ts), then compares
 * it with the live project through PostgREST's own schema description (the
 * service key that is already configured; no extra credential):
 *   - tables and their columns (public schema, as the API exposes them);
 *   - callable functions (RPCs);
 *   - reference data the migrations seed: plans, platform_policies,
 *     email_provider_plans, provider_rates (a live value that differs from
 *     the seed is reported: a fresh install would NOT have it).
 * Prints names and differences only, never a secret. Exit 1 on a schema
 * difference; reference-data differences are listed as notes (they are often
 * deliberate edits that must be carried into the new install).
 *
 *   npx tsx scripts/bootstrap/schema-parity.ts            (against SUPABASE_URL)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { freshInstall } from './pglite-install.ts';

const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }

const REFERENCE: Array<{ table: string; key: string; cols: string[] }> = [
  { table: 'plans', key: 'id', cols: ['id', 'monthly_price_cents', 'fee_bps', 'discount_codes_enabled', 'discount_code_limit'] },
  { table: 'platform_policies', key: 'key', cols: ['key', 'value'] },
  { table: 'email_provider_plans', key: 'provider', cols: ['provider', 'plan', 'daily_limit', 'monthly_limit', 'priority', 'active'] },
  // Rows carry random ids: compared by what they price.
  { table: 'provider_rates', key: 'provider|unit|period', cols: ['provider', 'unit', 'period', 'unit_cost_micros', 'included_units', 'effective_to'] },
];

export type Schema = { tables: Record<string, string[]>; functions: string[] };

/** The difference between two schemas, as readable lines (pure; tested). */
export function diffSchemas(fresh: Schema, live: Schema): string[] {
  const out: string[] = [];
  for (const t of Object.keys(fresh.tables).sort()) {
    if (!live.tables[t]) { out.push('table missing in live: ' + t); continue; }
    for (const c of fresh.tables[t]) if (!live.tables[t].includes(c)) out.push('column missing in live: ' + t + '.' + c);
    for (const c of live.tables[t]) if (!fresh.tables[t].includes(c)) out.push('column only in live (not in any migration): ' + t + '.' + c);
  }
  for (const t of Object.keys(live.tables).sort()) if (!fresh.tables[t]) out.push('table only in live (not in any migration): ' + t);
  for (const f of fresh.functions) if (!live.functions.includes(f)) out.push('function missing in live: ' + f);
  for (const f of live.functions) if (!fresh.functions.includes(f)) out.push('function only in live (not in any migration): ' + f);
  return out;
}

async function freshSchema(db: any, exposed: Set<string>): Promise<Schema> {
  const cols = (await db.query("select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position")).rows;
  const tables: Record<string, string[]> = {};
  for (const r of cols) if (exposed.has(r.table_name)) (tables[r.table_name] = tables[r.table_name] || []).push(r.column_name);
  // What PostgREST can call: not extension-owned (Supabase keeps pgcrypto in
  // its own schema), not trigger functions.
  const fns = (await db.query(`select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege('service_role', p.oid, 'execute')
      and pg_get_function_result(p.oid) not in ('trigger', 'event_trigger')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`)).rows.map((r: any) => r.proname);
  return { tables, functions: fns.sort() };
}

/** Functions Supabase itself puts in public (dashboard features), never ours. */
const SUPABASE_OWN_FUNCTIONS = ['rls_auto_enable'];

/** Every public table in a fresh install must enable row level security itself. */
export async function tablesWithoutRls(db: any): Promise<string[]> {
  return (await db.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1")).rows.map((r: any) => r.relname);
}

async function liveSchema(): Promise<Schema> {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed (names only are ever printed)');
  const spec: any = await (await fetch(url + '/rest/v1/', { headers: { apikey: key, authorization: 'Bearer ' + key, accept: 'application/openapi+json' } })).json();
  const tables: Record<string, string[]> = {};
  for (const [name, def] of Object.entries<any>(spec.definitions || {})) tables[name] = Object.keys(def.properties || {});
  const functions = Object.keys(spec.paths || {}).filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5)).filter((f) => !SUPABASE_OWN_FUNCTIONS.includes(f)).sort();
  return { tables, functions };
}

async function liveRows(table: string): Promise<any[]> {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const r = await fetch(url + '/rest/v1/' + table + '?select=*', { headers: { apikey: key, authorization: 'Bearer ' + key } });
  return r.ok ? r.json() : [];
}

const norm = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

if (process.argv[1] && /schema-parity\.ts$/.test(process.argv[1])) {
  (async () => {
    const live = await liveSchema();
    const { db, applied } = await freshInstall();
    // PostgREST lists what the API exposes; compare like with like.
    const fresh = await freshSchema(db, new Set(Object.keys(live.tables)));
    const exposedFresh = (await db.query("select table_name from information_schema.tables where table_schema = 'public'")).rows.map((r: any) => r.table_name);
    for (const t of exposedFresh) if (!live.tables[t]) fresh.tables[t] = (await db.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [t])).rows.map((r: any) => r.column_name);
    const diffs = diffSchemas(fresh, live);
    const noRls = await tablesWithoutRls(db);
    for (const t of noRls) diffs.push('table without row level security in a fresh install: ' + t);
    console.log('fresh install: ' + applied.length + ' migrations, ' + Object.keys(fresh.tables).length + ' tables, ' + fresh.functions.length + ' functions');
    console.log('live:          ' + Object.keys(live.tables).length + ' tables, ' + live.functions.length + ' functions');
    console.log('\nSchema differences: ' + (diffs.length || 'none'));
    for (const d of diffs) console.log('  ' + d);

    console.log('\nReference data the migrations seed (live vs a fresh install):');
    for (const ref of REFERENCE) {
      const freshRows = (await db.query('select * from public.' + ref.table)).rows;
      const liveR = await liveRows(ref.table);
      const keyOf = (r: any) => ref.key.split('|').map((k) => String(r[k] ?? '')).join('|');
      const cols = ref.cols.length ? ref.cols : Object.keys(freshRows[0] || {}).filter((c) => !/created_at|updated_at/.test(c));
      const fm = new Map<string, any>(freshRows.map((r: any) => [keyOf(r), r]));
      const lm = new Map<string, any>(liveR.map((r: any) => [keyOf(r), r]));
      const notes: string[] = [];
      for (const [k, f] of fm) {
        const l = lm.get(k);
        if (!l) { notes.push('only in a fresh install: ' + k); continue; }
        for (const c of cols) if (c in f && norm(f[c]) !== norm(l[c])) notes.push(k + '.' + c + ': fresh ' + norm(f[c]) + ' / live ' + norm(l[c]));
      }
      for (const k of lm.keys()) if (!fm.has(k)) notes.push('only in live (carry it over or add a migration): ' + k);
      console.log('  ' + ref.table + ': ' + (notes.length ? notes.length + ' difference(s)' : 'identical'));
      for (const n of notes.slice(0, 12)) console.log('    ' + n);
    }
    console.log('\n' + (diffs.length ? 'SCHEMA DIFFERS' : 'SCHEMA PARITY OK'));
    process.exit(diffs.length ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
