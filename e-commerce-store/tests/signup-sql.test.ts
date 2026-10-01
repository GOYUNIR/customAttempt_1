import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// 00041 (with 00039 for the shared address lock/aliases) in a REAL Postgres.
const mig = (n: string) => readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', n), 'utf8');
const DEFAULT = '00000000-0000-0000-0000-00000000000d';
let db: PGlite;
const claim = async (email: string, slug: string, token: string, hold = 48) =>
  (await db.query<any>("select * from claim_signup_name($1, 'Store', $2, $3, 'v1', '1.2.3.4', $4, 7, 14)", [email, slug, token, hold])).rows[0].result;
const complete = async (token: string) => (await db.query<any>('select * from complete_signup($1)', [token])).rows[0];

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.tenants (id uuid primary key default gen_random_uuid(), name text, slug text unique not null,
      license_status text not null default 'active', plan_id text default 'free', connect_charges_enabled boolean default false,
      created_at timestamptz default now(), updated_at timestamptz default now());
    create table public.users (id uuid primary key default gen_random_uuid(), email text, role text, tenant_id uuid);
    create table public.products (id uuid primary key default gen_random_uuid(), tenant_id uuid);
    create table public.plans (id text primary key);
    insert into public.plans values ('free'), ('starter'), ('growth'), ('scale');
    insert into public.tenants (id, name, slug, created_at) values ('${DEFAULT}', 'Original', 'original', now() - interval '400 days');
  `);
  await db.exec(mig('00039_store_address_changes.sql'));
  await db.exec(mig('00041_self_serve_signup.sql'));
});

test('a name is claimed once; another email cannot take a held name', async () => {
  assert.equal(await claim('a@x.test', 'alpha', 'tA'), 'claimed');
  assert.equal(await claim('b@x.test', 'alpha', 'tB'), 'taken');
});

test('the same email asking again replaces its earlier pending signup and frees that name', async () => {
  assert.equal(await claim('a@x.test', 'alpha-two', 'tA2'), 'claimed');
  assert.equal(await claim('b@x.test', 'alpha', 'tB2'), 'claimed', 'the replaced name is free again');
});

test('a hold that expired releases its name', async () => {
  assert.equal(await claim('c@x.test', 'charlie', 'tC'), 'claimed');
  await db.exec("update merchant_signups set expires_at = now() - interval '1 second' where token_hash = 'tC'");
  assert.equal(await claim('d@x.test', 'charlie', 'tD'), 'claimed');
});

test('completing creates the Free store once; replays and expired links fail', async () => {
  const r = await complete('tD');
  assert.equal(r.result, 'created');
  const t = (await db.query<any>('select slug, plan_id, license_status from tenants where id = $1', [r.tenant_id])).rows[0];
  assert.deepEqual(t, { slug: 'charlie', plan_id: 'free', license_status: 'active' });
  assert.equal((await complete('tD')).result, 'already', 'a replayed link does not create a second store');
  assert.equal((await complete('tC')).result, 'expired');
  assert.equal((await complete('nope')).result, 'invalid');
});

test('an email that already has an account gets no second store', async () => {
  await db.exec("insert into users (email, role, tenant_id) values ('e@x.test', 'owner', null)");
  assert.equal(await claim('e@x.test', 'echo', 'tE'), 'claimed');
  assert.equal((await complete('tE')).result, 'has_account');
  assert.equal((await db.query<any>("select count(*)::int as n from tenants where slug = 'echo'")).rows[0].n, 0);
});

test('an ABANDONED store releases its name; an active one and the original store never do', async () => {
  await db.exec(`
    insert into tenants (name, slug, created_at) values ('Ghost', 'ghost', now() - interval '30 days');            -- no owner ever, no payments, no products
    insert into tenants (name, slug, created_at) values ('Busy', 'busy', now() - interval '30 days');
    insert into products (tenant_id) select id from tenants where slug = 'busy';
    insert into users (email, role, tenant_id) select 'busy@x.test', 'owner', id from tenants where slug = 'busy';
    insert into tenants (name, slug, created_at) values ('Paid', 'paid', now() - interval '30 days');
    update tenants set plan_id = 'growth' where slug = 'paid';
  `);
  assert.equal(await claim('f@x.test', 'ghost', 'tF'), 'claimed', 'abandoned: name released');
  const ghost = (await db.query<any>("select license_status, slug from tenants where name = 'Ghost'")).rows[0];
  assert.equal(ghost.license_status, 'expired');
  assert.ok(ghost.slug.startsWith('x--'), 'suspended, name tombstoned (data kept): ' + ghost.slug);
  assert.equal(await claim('g@x.test', 'busy', 'tG'), 'taken', 'a store with an owner and a product keeps its name');
  assert.equal(await claim('h@x.test', 'paid', 'tH'), 'taken', 'a paid store keeps its name');
  assert.equal(await claim('i@x.test', 'original', 'tI'), 'taken', 'the original store is never released');
});

test('a young store is not abandoned, however empty', async () => {
  await db.exec("insert into tenants (name, slug, created_at) values ('Fresh', 'fresh', now() - interval '1 day')");
  assert.equal(await claim('j@x.test', 'fresh', 'tJ'), 'taken');
});
