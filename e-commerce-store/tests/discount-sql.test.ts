import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// 00045 in a REAL Postgres: reservation, limits, isolation, redemption, release.
const mig = (n: string) => readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', n), 'utf8');
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
let db: PGlite;
const reserve = async (tenant: string, code: string, email: string, hold: string, subtotal = 5000, currency = 'usd', ttl = 1800) =>
  (await db.query<any>('select reserve_discount($1, $2, $3, $4, $5, $6, $7) as r', [tenant, code, email, hold, subtotal, currency, ttl])).rows[0].r;
const mk = (tenant: string, code: string, extra = '') =>
  db.exec(`insert into discount_codes (tenant_id, code, kind, percent_bps, created_by ${extra ? ',' + extra.split('=')[0] : ''}) values ('${tenant}', '${code}', 'percent', 1000, 'owner@x.test' ${extra ? ',' + extra.split('=')[1] : ''})`);

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.tenants (id uuid primary key);
    insert into public.tenants values ('${A}'), ('${B}');
    create table public.plans (id text primary key);
    insert into public.plans values ('free'), ('starter'), ('growth'), ('scale');
  `);
  await db.exec(mig('00045_discount_codes.sql'));
});

test('plan flag is off everywhere; active-code caps are plan data', async () => {
  const rows = (await db.query<any>('select id, discount_codes_enabled, discount_code_limit from plans order by id')).rows;
  assert.ok(rows.every((r: any) => r.discount_codes_enabled === false));
  assert.deepEqual(Object.fromEntries(rows.map((r: any) => [r.id, r.discount_code_limit])), { free: 3, growth: null, scale: null, starter: 10 });
});

test('a code is one store\'s: the same word in another store is not it', async () => {
  await mk(A, 'SPRING10');
  assert.equal((await reserve(A, 'spring10', 'x@a.test', 'h1')).result, 'ok', 'case-insensitive');
  assert.equal((await reserve(B, 'SPRING10', 'x@a.test', 'h2')).result, 'invalid', 'store B cannot use store A\'s code');
  await mk(B, 'SPRING10');
  assert.equal((await reserve(B, 'SPRING10', 'y@b.test', 'h3')).result, 'ok', 'store B\'s own SPRING10 is separate');
});

test('per-customer limit (default 1); the same attempt re-reserving is fine', async () => {
  await mk(A, 'ONCE');
  assert.equal((await reserve(A, 'ONCE', 'p@a.test', 'o1')).result, 'ok');
  assert.equal((await reserve(A, 'ONCE', 'p@a.test', 'o1')).result, 'ok', 'a double tap on the same checkout');
  assert.equal((await reserve(A, 'ONCE', 'P@A.TEST', 'o2')).result, 'invalid', 'a second checkout by the same customer');
  assert.equal((await reserve(A, 'ONCE', 'q@a.test', 'o3')).result, 'ok', 'another customer');
});

test('total uses hold under concurrency; an expired hold stops counting; release gives it back', async () => {
  await mk(A, 'FIRST3', 'max_uses, max_uses_per_customer=3, 5');
  const all = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(A, 'FIRST3', 'c' + i + '@a.test', 'f' + i)));
  assert.equal(all.filter((r: any) => r.result === 'ok').length, 3);
  await db.query("update discount_redemptions set expires_at = now() - interval '1 second' where hold_key = 'f0'");
  assert.equal((await reserve(A, 'FIRST3', 'late@a.test', 'f10')).result, 'ok', 'a lapsed hold freed its slot');
  await db.query("select release_discount($1, 'f1')", [A]);
  assert.equal((await reserve(A, 'FIRST3', 'late2@a.test', 'f11')).result, 'ok', 'a released hold freed its slot');
  assert.equal((await reserve(A, 'FIRST3', 'late3@a.test', 'f12')).result, 'invalid', 'and then it is full again');
});

test('redeemed uses count forever (a refund does not give them back)', async () => {
  await mk(A, 'ONEUSE', 'max_uses=1');
  assert.equal((await reserve(A, 'ONEUSE', 'r@a.test', 'u1')).result, 'ok');
  assert.equal((await db.query<any>("select redeem_discount($1, 'u1', 'A-1', 500) as r", [A])).rows[0].r, true);
  await db.query("select release_discount($1, 'u1')", [A]);
  assert.equal((await db.query<any>("select status from discount_redemptions where hold_key = 'u1'")).rows[0].status, 'redeemed', 'release never undoes a redemption');
  assert.equal((await reserve(A, 'ONEUSE', 's@a.test', 'u2')).result, 'invalid');
});

test('dates, active switch, minimum order, currency of fixed codes', async () => {
  await mk(A, 'LATER', "starts_at=now() + interval '1 day'");
  assert.equal((await reserve(A, 'LATER', 'd@a.test', 'd1')).result, 'invalid');
  await mk(A, 'GONE', "ends_at=now() - interval '1 second'");
  assert.equal((await reserve(A, 'GONE', 'd@a.test', 'd2')).result, 'invalid');
  await mk(A, 'OFFNOW', 'active=false');
  assert.equal((await reserve(A, 'OFFNOW', 'd@a.test', 'd3')).result, 'invalid');
  await mk(A, 'MIN50', 'min_subtotal_cents=5000');
  const r = await reserve(A, 'MIN50', 'd@a.test', 'd4', 4999);
  assert.deepEqual([r.result, Number(r.min_subtotal_cents)], ['minimum', 5000]);
  await db.exec(`insert into discount_codes (tenant_id, code, kind, amount_cents, currency, created_by) values ('${A}', 'FIVEOFF', 'fixed', 500, 'usd', 'o')`);
  assert.equal((await reserve(A, 'FIVEOFF', 'd@a.test', 'd5', 5000, 'eur')).result, 'invalid', 'a $5 code is not a €5 code');
  assert.equal((await reserve(A, 'FIVEOFF', 'd@a.test', 'd6', 5000, 'usd')).result, 'ok');
});

test('the table refuses junk: >90%, both kinds at once, lowercase, too short', async () => {
  await assert.rejects(db.exec(`insert into discount_codes (tenant_id, code, kind, percent_bps, created_by) values ('${A}', 'NINETY1', 'percent', 9100, 'o')`), /check/);
  await assert.rejects(db.exec(`insert into discount_codes (tenant_id, code, kind, percent_bps, amount_cents, currency, created_by) values ('${A}', 'BOTH', 'fixed', 100, 100, 'usd', 'o')`), /check/);
  await assert.rejects(db.exec(`insert into discount_codes (tenant_id, code, kind, percent_bps, created_by) values ('${A}', 'abc', 'percent', 100, 'o')`), /check/);
});
