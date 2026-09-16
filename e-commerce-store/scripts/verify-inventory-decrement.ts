/**
 * INVENTORY DECREMENT VERIFICATION (H4).
 *
 *   npm run verify:inventory
 *
 * decrementInventory is what a Postgres-gated checkout will call to decide
 * whether a sale may proceed. "The migration ran" proves nothing about it, so
 * this exercises the real function against a real PostgREST dialect (the fake
 * server, which enforces CHECK constraints) and asserts the behaviours money
 * depends on:
 *
 *   - a missing inventory row REFUSES the sale (the H4 blocker restated: this
 *     is what every purchase would have hit before the backfill)
 *   - a normal decrement reduces stock by exactly the quantity
 *   - buying more than remains is refused, and does NOT partially decrement
 *   - the last unit can be sold, and the next attempt is refused
 *   - concurrent buyers cannot oversell: N parallel attempts on M units
 *     succeed exactly M times
 *   - quantity_available never goes negative
 */
import { startFakePostgrest } from './fake-postgrest';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const TENANT = '00000000-0000-4000-8000-0000000000aa';

async function main() {
  const db = await startFakePostgrest();
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + db.port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:' + db.port;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'inventory-key';
  process.env.USE_POSTGRES_PRIMARY = 'true';

  const { decrementInventory, getInventoryLevel } = await import('../lib/inventory');

  console.log('\nInventory decrement — the gate a Postgres checkout runs on\n' + '='.repeat(66));

  const variant = (n: string) => '00000000-0000-4000-8000-00000000' + n;
  const seed = (variantId: string, qty: number) => {
    db.tables['inventory_levels'] = db.tables['inventory_levels'] || [];
    const existing = db.tables['inventory_levels'].find((r) => r.variant_id === variantId);
    if (existing) existing.quantity_available = qty;
    else db.tables['inventory_levels'].push({
      id: 'inv-' + variantId.slice(-4), tenant_id: TENANT, variant_id: variantId,
      quantity_available: qty, quantity_reserved: 0,
    });
  };
  const avail = (variantId: string) =>
    (db.tables['inventory_levels'] || []).find((r) => r.variant_id === variantId)?.quantity_available;

  // ── 1. THE BLOCKER: no row at all ───────────────────────────────────────
  const missing = await decrementInventory(TENANT, variant('0001'), 1);
  check(missing.ok === false, 'a variant with NO inventory row REFUSES the sale', JSON.stringify(missing));
  check(missing.ok === false && missing.reason === 'no_inventory_row',
    'and the reason is no_inventory_row — this is what every purchase hit pre-backfill',
    JSON.stringify(missing));

  // ── 2. a normal sale ────────────────────────────────────────────────────
  const v2 = variant('0002');
  seed(v2, 10);
  const one = await decrementInventory(TENANT, v2, 3);
  check(one.ok === true, 'a normal decrement succeeds', JSON.stringify(one));
  check(one.ok === true && one.remaining === 7, 'and reports the new remaining (7)', JSON.stringify(one));
  check(avail(v2) === 7, 'the DATABASE really holds 7, not just the return value', String(avail(v2)));
  const level = await getInventoryLevel(TENANT, v2);
  check(level?.quantityAvailable === 7, 'and getInventoryLevel agrees', JSON.stringify(level));

  // ── 3. overselling one buyer ────────────────────────────────────────────
  const v3 = variant('0003');
  seed(v3, 2);
  const tooMany = await decrementInventory(TENANT, v3, 5);
  check(tooMany.ok === false && tooMany.reason === 'insufficient_stock',
    'buying more than remains is refused', JSON.stringify(tooMany));
  check(avail(v3) === 2, 'and stock is UNCHANGED — no partial decrement', String(avail(v3)));

  // ── 4. the last unit ────────────────────────────────────────────────────
  const v4 = variant('0004');
  seed(v4, 1);
  const last = await decrementInventory(TENANT, v4, 1);
  check(last.ok === true && last.remaining === 0, 'the LAST unit can be sold', JSON.stringify(last));
  check(avail(v4) === 0, 'stock is exactly 0', String(avail(v4)));
  const after = await decrementInventory(TENANT, v4, 1);
  check(after.ok === false && after.reason === 'insufficient_stock',
    'and the next buyer is refused rather than going negative', JSON.stringify(after));
  check(avail(v4) === 0, 'quantity_available never went negative', String(avail(v4)));

  // ── 5. CONCURRENCY: 12 buyers, 5 units ──────────────────────────────────
  // The real oversell question. decrementInventory holds a lock AND does a
  // compare-and-swap; if either were absent this is where it shows.
  const v5 = variant('0005');
  const UNITS = 5;
  const BUYERS = 12;
  seed(v5, UNITS);
  const results = await Promise.all(
    Array.from({ length: BUYERS }, () => decrementInventory(TENANT, v5, 1)),
  );
  const sold = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok).length;
  console.log(`     ${BUYERS} concurrent buyers on ${UNITS} units -> ${sold} sold, ${refused} refused`);
  check(sold === UNITS, `exactly ${UNITS} succeeded — no oversell, no lost sale`, `sold=${sold}`);
  check(avail(v5) === 0, 'final stock is exactly 0', String(avail(v5)));
  check(refused === BUYERS - UNITS, 'every other buyer got a clean refusal', `refused=${refused}`);
  const reasons = [...new Set(results.filter((r) => !r.ok).map((r) => (r as { reason?: string }).reason))];
  console.log('     refusal reasons: ' + JSON.stringify(reasons));

  db.close();
  console.log('='.repeat(66));
  console.log(fail === 0 ? 'INVENTORY DECREMENT VERIFIED\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
