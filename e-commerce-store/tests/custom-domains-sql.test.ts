import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// 00040 in a REAL Postgres: caps land as plan data; one hostname belongs to
// exactly one store; one primary per store; hostnames are stored lower-case.
const MIGRATION = readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', '00040_custom_domains_multi.sql'), 'utf8');
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
let db: PGlite;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.tenants (id uuid primary key);
    insert into public.tenants values ('${A}'), ('${B}');
    create table public.plans (id text primary key);
    insert into public.plans values ('free'), ('starter'), ('growth'), ('scale');
  `);
  await db.exec(MIGRATION);
});

const add = (host: string, tenant: string, primary = false) =>
  db.query('insert into tenant_domains (hostname, tenant_id, verify_token, is_primary) values ($1, $2, $3, $4)', [host, tenant, 't', primary]);

test('caps are plan data: Free 1, Growth 3, Scale unlimited', async () => {
  const rows = (await db.query<any>('select id, custom_domain_limit from plans order by id')).rows;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.custom_domain_limit])), { free: 1, growth: 3, scale: null, starter: 1 });
});

test('one hostname belongs to exactly one store', async () => {
  await add('www.alpha.example', A);
  await assert.rejects(add('www.alpha.example', B), /duplicate key|unique/i);
});

test('one primary domain per store', async () => {
  await add('shop.alpha.example', A, true);
  await assert.rejects(add('shop2.alpha.example', A, true), /duplicate key|unique/i);
  await add('www.bravo.example', B, true); // another store has its own primary
});

test('hostnames are stored lower-case only', async () => {
  await assert.rejects(add('WWW.Mixed.example', A), /check/i);
});
