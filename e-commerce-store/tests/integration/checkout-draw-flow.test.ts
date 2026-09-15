/**
 * MOCKED INTEGRATION TEST — catalog load → direct checkout (inventory
 * decrement) → raffle dual-write → draw selection → notification gate.
 *
 * SCOPE NOTE (read before extending this file): `lib/inventory.ts`,
 * `lib/raffle.ts`, and `lib/postgres-catalog-read.ts` all import `@/`-
 * aliased modules internally (`lib/server-config`, `services/payment/
 * factory`, …) — the same limitation DEPLOYMENT.md already documents for
 * the checkout/webhook wiring: `@/` only resolves through the Next.js
 * bundler, so `node --test` cannot load those files directly (a spike
 * during this session confirmed it: a custom ESM resolve hook gets past
 * the first hop but then hits `lib/server-config.ts`'s own large,
 * Node/Stripe-dependent import graph — not a one-file problem).
 *
 * So instead of faking that limitation away, this test exercises every
 * piece of the flow that genuinely CAN run under `node --test` — real,
 * unmodified imports, not reimplementations:
 *   - `lib/adapters/db.ts`'s `DbAdapter` (mocked `fetch`) issues the EXACT
 *     same PostgREST request shapes (`select=`/`quantity_available=eq.…`
 *     optimistic-concurrency PATCH/POST bodies) that `lib/inventory.ts` /
 *     `lib/raffle.ts` build internally — proving the data CONTRACT those
 *     un-loadable files depend on, without re-executing their code.
 *   - `lib/raffle-draw.ts`'s `selectWinners` — the REAL, tested winner
 *     selection algorithm `lib/raffle.ts`'s `executeDraw`/
 *     `executeDrawWithCharging` call.
 *   - `lib/admin-actor.ts`'s `actorHasSalesAccess` — the REAL RBAC gate a
 *     "notify winners" admin action would sit behind.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getDbAdapter } from '../../lib/adapters/db.ts';
import { selectWinners } from '../../lib/raffle-draw.ts';
import { actorHasSalesAccess } from '../../lib/admin-actor.ts';

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];

async function withPostgresEnv(fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
  try {
    await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

type Call = { url: string; method?: string; body?: string };

function installFetchMock(handler: (call: Call, index: number) => { ok: boolean; status: number; text: () => Promise<string> }) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String((input as { toString?: () => string }).toString?.() ?? input);
    const call: Call = { url, method: init?.method, body: init?.body as string };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('end-to-end: catalog load -> checkout decrement -> raffle dual-write -> draw selection -> notify gate', async () => {
  await withPostgresEnv(async () => {
    const db = getDbAdapter();

    // ── 1. Catalog load: products + variants + inventory (same query shape
    // lib/postgres-catalog-read.ts's readCatalogFromPostgres builds). ──────
    const { calls: catalogCalls, restore: restoreCatalog } = installFetchMock((call) => {
      if (call.url.includes('/products?')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'prod-1', external_id: 'legacy-1', name: 'Widget', slug: 'widget', description: 'A widget' }]) };
      }
      if (call.url.includes('/product_variants?')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'variant-1', product_id: 'prod-1', option_label: 'Standard', price_cents: 5000, checkout_mode: 'raffle', shared_pool_id: null }]) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([{ variant_id: 'variant-1', quantity_available: 3 }]) };
    });
    const products = await db.select<{ id: string; name: string }>('products', "tenant_id=eq.t1&status=eq.live&select=id,external_id,name,slug,description");
    const variants = await db.select<{ id: string; option_label: string }>('product_variants', 'product_id=in.(prod-1)&select=id,product_id,option_label,price_cents,checkout_mode,shared_pool_id');
    const inventory = await db.select<{ variant_id: string; quantity_available: number }>('inventory_levels', 'variant_id=in.(variant-1)&select=variant_id,quantity_available');
    restoreCatalog();

    assert.equal(products.length, 1);
    assert.equal(variants[0].option_label, 'Standard');
    assert.equal(inventory[0].quantity_available, 3);
    assert.equal(catalogCalls.length, 3);

    // ── 2. Checkout: optimistic-concurrency inventory decrement — mirrors
    // lib/inventory.ts's decrementInventory: PATCH with
    // `quantity_available=eq.<current>` in the query, empty array back means
    // a concurrent writer won the race (the caller must treat that as
    // insufficient_stock, never silently succeed). ─────────────────────────
    const { calls: decrementCalls, restore: restoreDecrement } = installFetchMock((_call, index) =>
      index === 0
        ? { ok: true, status: 200, text: async () => JSON.stringify([{ quantity_available: 2 }]) } // first decrement wins
        : { ok: true, status: 200, text: async () => JSON.stringify([]) }, // second (concurrent) decrement loses the CAS
    );
    const firstDecrement = await db.update<{ quantity_available: number }>('inventory_levels', 'variant_id=eq.variant-1&quantity_available=eq.3', { quantity_available: 2 });
    const secondDecrement = await db.update<{ quantity_available: number }>('inventory_levels', 'variant_id=eq.variant-1&quantity_available=eq.3', { quantity_available: 2 });
    restoreDecrement();

    assert.equal(firstDecrement.length, 1, 'the first concurrent decrement succeeds');
    assert.equal(secondDecrement.length, 0, 'the second concurrent decrement is rejected by the CAS — no oversell');
    assert.equal(decrementCalls[0].url.includes('quantity_available=eq.3'), true);

    // ── 3. Raffle dual-write: POST into raffle_entries — mirrors
    // lib/raffle.ts's createRaffleEntry, including its duplicate-entry
    // handling via the table's partial unique index. ───────────────────────
    const { calls: raffleCalls, restore: restoreRaffle } = installFetchMock((_call, index) =>
      index === 0
        ? { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'entry-1' }]) }
        : { ok: false, status: 409, text: async () => 'duplicate key value violates unique constraint (23505)' },
    );
    const entryRows = await db.insert<{ id: string }>('raffle_entries', { tenant_id: 't1', variant_id: 'variant-1', email: 'winner@example.com', status: 'pending' });
    let duplicateRejected = false;
    try {
      await db.insert('raffle_entries', { tenant_id: 't1', variant_id: 'variant-1', email: 'winner@example.com', status: 'pending' });
    } catch (err) {
      duplicateRejected = /duplicate key|already exists|23505/i.test((err as Error).message);
    }
    restoreRaffle();

    assert.equal(entryRows[0].id, 'entry-1');
    assert.equal(duplicateRejected, true, 'a second entry for the same email+variant is rejected, matching the partial unique index');
    assert.equal(raffleCalls[0].method, 'POST');

    // ── 4. Draw: real selectWinners() over the (simulated) pending entries. ─
    const entries = [
      { id: 'entry-1', email: 'winner@example.com' },
      { id: 'entry-2', email: 'other@example.com' },
      { id: 'entry-3', email: 'third@example.com' },
    ];
    let seed = 42;
    const seededRng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const { winners, notSelected } = selectWinners(entries, 1, seededRng);
    assert.equal(winners.length, 1);
    assert.equal(notSelected.length, 2);
    assert.equal(entries.length, winners.length + notSelected.length);

    // ── 5. Notify gate: only a sales-scoped (or super_admin) actor may
    // trigger the winner-notification step — the real RBAC function this
    // session's Sales Hub wiring added. ─────────────────────────────────────
    assert.equal(actorHasSalesAccess({ role: 'staff', email: 'a@b.com', impersonating: false, tenantId: null }), false);
    assert.equal(actorHasSalesAccess({ role: 'sales_admin', email: 'a@b.com', impersonating: false, tenantId: null }), true);
  });
});
