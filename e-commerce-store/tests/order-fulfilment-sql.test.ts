import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// 00043 in a REAL Postgres, on the orders columns it depends on (00009's checks).
const mig = (n: string) => readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', n), 'utf8');
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
let db: PGlite;
const ship = async (tenant: string, order: string, tracking = '1Z999', carrier = 'UPS') =>
  (await db.query<any>('select mark_order_shipped($1, $2, $3, $4, $5, $6) as r', [tenant, order, carrier, tracking, 'https://www.ups.com/track?tracknum=' + tracking, 'owner@a.test'])).rows[0].r;
const refund = async (tenant: string, pi: string, cents: number) => (await db.query<any>('select set_order_refund($1, $2, $3) as r', [tenant, pi, cents])).rows[0].r;
const order = async (id: string) => (await db.query<any>('select status, payment_status, refunded_cents, refunded_at from orders where id = $1', [id])).rows[0];

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.tenants (id uuid primary key);
    insert into public.tenants values ('${A}'), ('${B}');
    create table public.orders (
      id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants (id), order_ref text not null,
      status text not null default 'pending' check (status in ('pending', 'awaiting_approval', 'confirmed', 'fulfilled', 'cancelled', 'refunded')),
      payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'partially_refunded', 'refunded', 'invoiced')),
      total_cents bigint not null default 0, stripe_payment_intent_id text, updated_at timestamptz default now());
    insert into public.orders (id, tenant_id, order_ref, status, payment_status, total_cents, stripe_payment_intent_id) values
      ('10000000-0000-0000-0000-000000000001', '${A}', 'A-1', 'confirmed', 'paid', 3400, 'pi_a1'),
      ('10000000-0000-0000-0000-000000000002', '${A}', 'A-2', 'confirmed', 'unpaid', 1000, null),
      ('10000000-0000-0000-0000-000000000003', '${B}', 'B-1', 'confirmed', 'paid', 5000, 'pi_b1'),
      ('10000000-0000-0000-0000-000000000004', '${A}', 'A-3', 'confirmed', 'paid', 2000, 'pi_a3');
  `);
  await db.exec(mig('00043_order_fulfilment.sql'));
});

const A1 = '10000000-0000-0000-0000-000000000001', A2 = '10000000-0000-0000-0000-000000000002', B1 = '10000000-0000-0000-0000-000000000003', A3 = '10000000-0000-0000-0000-000000000004';

test('shipping a paid order: once; the second press changes nothing', async () => {
  assert.equal(await ship(A, A1), 'shipped');
  assert.equal((await order(A1)).status, 'fulfilled');
  assert.equal(await ship(A, A1, 'DIFFERENT'), 'already');
  const rows = (await db.query<any>('select tracking_number from order_fulfilments where order_id = $1', [A1])).rows;
  assert.deepEqual(rows.map((r: any) => r.tracking_number), ['1Z999'], 'the first tracking stands (no edit in v1)');
});

test('another store cannot ship (or even find) this store\'s order', async () => {
  assert.equal(await ship(A, B1), 'not_found');
  assert.equal(await ship(B, A3), 'not_found');
  assert.equal((await order(B1)).status, 'confirmed');
  assert.equal((await db.query<any>('select count(*)::int n from order_fulfilments where order_id in ($1, $2)', [B1, A3])).rows[0].n, 0);
});

test('an unpaid order cannot be shipped', async () => {
  assert.equal(await ship(A, A2), 'not_paid');
});

test('refunds: partial then full; never lowered; another store\'s payment untouched', async () => {
  assert.equal(await refund(A, 'pi_a3', 500), true);
  assert.deepEqual([(await order(A3)).payment_status, Number((await order(A3)).refunded_cents)], ['partially_refunded', 500]);
  assert.equal(await ship(A, A3), 'shipped', 'a partly refunded order can still ship');
  assert.equal(await refund(A, 'pi_a3', 300), true, 'an older event arriving late');
  assert.equal(Number((await order(A3)).refunded_cents), 500, 'not lowered');
  assert.equal(await refund(A, 'pi_a3', 2000), true);
  assert.equal((await order(A3)).payment_status, 'refunded');
  assert.ok((await order(A3)).refunded_at);
  assert.equal(await refund(A, 'pi_b1', 5000), false, 'store A naming store B\'s payment changes nothing');
  assert.equal((await order(B1)).payment_status, 'paid');
});

test('a fully refunded order cannot be shipped', async () => {
  await refund(B, 'pi_b1', 5000);
  assert.equal(await ship(B, B1), 'not_paid');
});

test('the table refuses junk', async () => {
  await assert.rejects(db.query("insert into order_fulfilments (tenant_id, order_id, carrier, tracking_number, tracking_url, shipped_by) values ($1, $2, 'X', 'T', 'javascript:alert(1)', 'x')", [A, A2]), /check/);
  await assert.rejects(db.query("insert into order_fulfilments (tenant_id, order_id, carrier, tracking_number, shipped_by) values ($1, $2, 'X', '', 'x')", [A, A2]), /check/);
});
