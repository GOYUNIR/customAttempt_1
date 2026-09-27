import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// Runs supabase/migrations/00037 in a REAL Postgres (PGlite) against minimal
// stand-ins for the tables it references, then exercises every function. The
// live race proof (12 buyers, 5 units, real Supabase) is
// scripts/verify-stock-race.ts; this is the logic, statement by statement.
const MIGRATION = readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', '00037_stock_holds_movements.sql'), 'utf8');
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const V1 = '10000000-0000-0000-0000-000000000001';
const V2 = '10000000-0000-0000-0000-000000000002';
const VB = '20000000-0000-0000-0000-000000000001';
let db: PGlite;

const j = async (sql: string, params: unknown[] = []) => ((await db.query<any>(sql, params)).rows[0] as any);
const fn = async (name: string, args: unknown[]) => {
  const ph = args.map((_, i) => '$' + (i + 1)).join(', ');
  return Object.values(await j(`select public.${name}(${ph}) as r`, args))[0] as any;
};
const level = async (v: string) => j('select on_hand, held, available from public.stock_levels where variant_id = $1', [v]);
const items = (...pairs: Array<[string, number]>) => JSON.stringify(pairs.map(([variant_id, quantity]) => ({ variant_id, quantity })));

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.tenants (id uuid primary key);
    create table public.product_variants (id uuid primary key, tenant_id uuid not null references public.tenants(id));
    create table public.inventory_levels (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references public.tenants(id), variant_id uuid not null references public.product_variants(id),
      quantity_available integer not null default 0 check (quantity_available >= 0),
      quantity_reserved integer not null default 0, updated_at timestamptz not null default now(), unique (variant_id));
    insert into public.tenants values ('${A}'), ('${B}');
    insert into public.product_variants values ('${V1}', '${A}'), ('${V2}', '${A}'), ('${VB}', '${B}');
    insert into public.inventory_levels (tenant_id, variant_id, quantity_available) values ('${A}', '${V1}', 5), ('${B}', '${VB}', 3);
  `);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // safe to re-run
});

test('opening balances are recorded once, even when the migration runs twice', async () => {
  const r = await j(`select count(*)::int as n from public.stock_movements where reason = 'opening'`);
  assert.equal(r.n, 2);
});

test('five holds on five units; the sixth is refused; nothing is decremented yet', async () => {
  for (let i = 1; i <= 5; i++) assert.equal((await fn('stock_reserve', [A, 'k' + i, items([V1, 1]), 1800, null])).ok, true, 'buyer ' + i);
  const sixth = await fn('stock_reserve', [A, 'k6', items([V1, 1]), 1800, null]);
  assert.deepEqual([sixth.ok, sixth.reason, sixth.available], [false, 'insufficient', 0]);
  assert.deepEqual(await level(V1), { on_hand: 5, held: 5, available: 0 });
});

test('a repeated reserve with the same key is not a second hold', async () => {
  const again = await fn('stock_reserve', [A, 'k1', items([V1, 1]), 1800, null]);
  assert.equal(again.already, 'held');
  assert.equal((await level(V1)).held, 5);
});

test('release frees the unit for the next buyer', async () => {
  assert.equal(await fn('stock_release', [A, 'k5']), 1);
  assert.equal((await fn('stock_reserve', [A, 'k6', items([V1, 1]), 1800, null])).ok, true);
  assert.equal((await level(V1)).available, 0);
});

test('an expired hold stops counting and is tidied on the next lock', async () => {
  await fn('stock_release', [A, 'k6']);
  assert.equal((await fn('stock_reserve', [A, 'short', items([V1, 1]), 0, null])).ok, true); // expires immediately
  assert.equal((await level(V1)).available, 1, 'expired hold no longer counts');
  assert.equal((await fn('stock_reserve', [A, 'k7', items([V1, 1]), 1800, null])).ok, true);
  const s = await j(`select status from public.stock_holds where hold_key = 'short'`);
  assert.equal(s.status, 'released');
});

test('a paid sale decrements once, converts the hold, and is idempotent', async () => {
  const r1 = await fn('stock_commit_sale', [A, 'k1', items([V1, 1]), 'pi_1']);
  assert.deepEqual([r1.items[0].applied, r1.items[0].remaining, r1.items[0].shortfall], [true, 4, 0]);
  const r2 = await fn('stock_commit_sale', [A, 'k1', items([V1, 1]), 'pi_1']);
  assert.deepEqual([r2.items[0].applied, r2.items[0].reason], [false, 'already']);
  assert.deepEqual(await level(V1), { on_hand: 4, held: 4, available: 0 });
  assert.equal((await j(`select status from public.stock_holds where hold_key = 'k1'`)).status, 'converted');
  assert.equal((await fn('stock_reserve', [A, 'k1', items([V1, 1]), 1800, null])).already, 'converted');
});

test('a recount keeps open checkouts: count 6 with 4 held leaves 2 to sell', async () => {
  const r = await fn('stock_set', [A, V1, 6, 'owner@x', 'shelf count']);
  assert.deepEqual([r.ok, r.before, r.on_hand, r.held], [true, 4, 6, 4]);
  assert.deepEqual(await level(V1), { on_hand: 6, held: 4, available: 2 });
});

test('adjust: +restock, -damaged, never below zero', async () => {
  assert.equal((await fn('stock_adjust', [A, V1, 3, 'restock', 'owner@x', null])).on_hand, 9);
  assert.equal((await fn('stock_adjust', [A, V1, -2, 'adjust', 'owner@x', 'damaged'])).on_hand, 7);
  const low = await fn('stock_adjust', [A, V1, -8, 'adjust', 'owner@x', null]);
  assert.deepEqual([low.ok, low.reason, low.on_hand], [false, 'below_zero', 7]);
});

test('paid after the hold lapsed and stock ran out: stops at 0, shortfall recorded', async () => {
  await fn('stock_set', [A, V2, 1, 'owner@x', null]); // first count creates the row
  const r = await fn('stock_commit_sale', [A, null, items([V2, 2]), 'pi_short']);
  assert.deepEqual([r.items[0].remaining, r.items[0].shortfall], [0, 1]);
  const m = await j(`select delta, quantity_after, shortfall from public.stock_movements where reference = 'pi_short'`);
  assert.deepEqual(m, { delta: -1, quantity_after: 0, shortfall: 1 });
});

test('a cart is all or nothing', async () => {
  await fn('stock_set', [A, V2, 1, 'owner@x', null]);
  const r = await fn('stock_reserve', [A, 'cart1', items([V1, 1], [V2, 2]), 1800, null]);
  assert.deepEqual([r.ok, r.reason, r.variant_id], [false, 'insufficient', V2]);
  assert.equal((await j(`select count(*)::int as n from public.stock_holds where hold_key = 'cart1'`)).n, 0, 'no partial hold');
  assert.equal((await fn('stock_reserve', [A, 'cart2', items([V1, 1], [V2, 1]), 1800, null])).ok, true);
});

test('another store can touch nothing of this one', async () => {
  assert.equal((await fn('stock_reserve', [B, 'x', items([V1, 1]), 1800, null])).reason, 'no_stock_row');
  assert.equal((await fn('stock_set', [B, V1, 100, 'b@x', null])).reason, 'no_stock_row');
  assert.equal((await fn('stock_adjust', [B, V1, 100, 'restock', 'b@x', null])).reason, 'no_stock_row');
  const sale = await fn('stock_commit_sale', [B, null, items([V1, 1]), 'pi_b']);
  assert.equal(sale.items[0].reason, 'no_stock_row');
  assert.equal(await fn('stock_release', [B, 'k2']), 0);
  assert.equal((await level(V1)).on_hand, 7, 'test4-side stock unchanged');
  // B's first count on A's variant cannot create a row either.
  await db.exec(`insert into public.product_variants values ('30000000-0000-0000-0000-000000000001', '${A}')`);
  assert.equal((await fn('stock_set', [B, '30000000-0000-0000-0000-000000000001', 5, 'b@x', null])).reason, 'no_stock_row');
});

test('history is append-only', async () => {
  await assert.rejects(db.exec(`update public.stock_movements set delta = 0`), /append-only/);
  await assert.rejects(db.exec(`delete from public.stock_movements`), /append-only/);
});

test('the public API roles can call nothing and read nothing', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec('set role ' + role);
    try {
      await assert.rejects(db.query(`select public.stock_set($1, $2, 99, 'x', null)`, [A, V1]), /permission denied/, role + ' stock_set');
      await assert.rejects(db.query(`select public.stock_reserve($1, 'z', '[]', 60, null)`, [A]), /permission denied/, role + ' stock_reserve');
      await assert.rejects(db.query(`select * from public.stock_levels`), /permission denied/, role + ' stock_levels');
    } finally {
      await db.exec('reset role');
    }
  }
});
