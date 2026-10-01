import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// Runs supabase/migrations/00039 in a REAL Postgres (PGlite) against a
// minimal tenants table: the address change is all-or-nothing, a name held for
// 90 days cannot be taken, the cap counts changes (not aliases), and expired
// holds are released.
const MIGRATION = readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', '00039_store_address_changes.sql'), 'utf8');
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
let db: PGlite;
const change = async (tenant: string, slug: string) =>
  ((await db.query<any>('select * from change_store_slug($1, $2, 90, 3, 30)', [tenant, slug])).rows[0]);
const slugOf = async (tenant: string) => ((await db.query<any>('select slug from tenants where id = $1', [tenant])).rows[0].slug);

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.tenants (id uuid primary key, slug text unique not null, updated_at timestamptz default now());
    insert into public.tenants (id, slug) values ('${A}', 'alpha'), ('${B}', 'bravo');
  `);
  await db.exec(MIGRATION);
});

test('a change moves the store and holds its old name as an alias', async () => {
  const r = await change(A, 'alpha-new');
  assert.equal(r.result, 'changed');
  assert.equal(await slugOf(A), 'alpha-new');
  const alias = (await db.query<any>("select tenant_id, expires_at > now() + interval '89 days' as held90 from tenant_slug_aliases where slug = 'alpha'")).rows[0];
  assert.equal(alias.tenant_id, A);
  assert.equal(alias.held90, true, 'held for 90 days');
});

test('another store cannot take a current name or a held old name', async () => {
  assert.equal((await change(B, 'alpha-new')).result, 'taken');
  assert.equal((await change(B, 'alpha')).result, 'held', 'the old name is reserved for its store');
  assert.equal(await slugOf(B), 'bravo', 'nothing changed');
});

test('the store may take back its own held name', async () => {
  assert.equal((await change(A, 'alpha')).result, 'changed');
  assert.equal(await slugOf(A), 'alpha');
  assert.equal((await db.query<any>("select count(*)::int as n from tenant_slug_aliases where slug = 'alpha'")).rows[0].n, 0);
});

test('the cap counts CHANGES, so flipping between two names cannot dodge it', async () => {
  // A has made 2 changes (alpha -> alpha-new -> alpha). One more is allowed.
  assert.equal((await change(A, 'alpha-new')).result, 'changed');
  assert.equal((await change(A, 'alpha')).result, 'limit', '4th change in 30 days is refused');
  assert.equal(await slugOf(A), 'alpha-new');
});

test('when the hold ends the name is released to anyone', async () => {
  await db.exec("update tenant_slug_aliases set expires_at = now() - interval '1 second' where slug = 'alpha'");
  assert.equal((await change(B, 'alpha')).result, 'changed', 'released after 90 days');
  assert.equal(await slugOf(B), 'alpha');
});

test('same name and unknown store are answered, not errors', async () => {
  assert.equal((await change(B, 'alpha')).result, 'unchanged');
  assert.equal((await change('00000000-0000-0000-0000-0000000000ff', 'x-y-z')).result, 'unknown_store');
});
