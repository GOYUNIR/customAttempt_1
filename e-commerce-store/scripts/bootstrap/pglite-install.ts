/**
 * FRESH INSTALL REHEARSAL (local): every migration, in order, on an EMPTY
 * Postgres (PGlite, in memory), with only what Supabase itself provides
 * stubbed (its roles, the auth schema's users table and auth.uid()). Proves
 * the migrations alone build the whole schema and its reference data, with no
 * hand-run SQL. Used by bootstrap (step "database", --target local), the
 * schema-parity check and the tests.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** What a new Supabase project already has before our first migration. */
export const SUPABASE_PRELUDE = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
  create or replace function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
  create or replace function auth.role() returns text language sql stable as $f$ select 'service_role'::text $f$;
  create or replace function auth.jwt() returns jsonb language sql stable as $f$ select '{}'::jsonb $f$;
`;

export function migrationFiles(root = process.cwd()): string[] {
  const dir = join(root, 'supabase', 'migrations');
  return readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort().map((f) => join(dir, f));
}

/** Apply the prelude and every migration; returns the db and what ran. */
export async function freshInstall(root = process.cwd()): Promise<{ db: any; applied: string[] }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db: any = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_PRELUDE);
  const applied: string[] = [];
  for (const file of migrationFiles(root)) {
    const name = file.split(/[\\/]/).pop()!;
    try {
      await db.exec(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(name + ': ' + ((err as Error)?.message || err));
    }
    applied.push(name);
  }
  return { db, applied };
}

if (process.argv[1] && /pglite-install\.ts$/.test(process.argv[1])) {
  freshInstall().then(async ({ db, applied }) => {
    const t = (await db.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows[0].n;
    const plans = (await db.query('select id from public.plans order by id')).rows.map((r: any) => r.id);
    console.log('applied ' + applied.length + ' migrations; ' + t + ' public tables; plans: ' + plans.join(', '));
  }).catch((e) => { console.error('FAILED ' + (e as Error).message); process.exit(1); });
}
