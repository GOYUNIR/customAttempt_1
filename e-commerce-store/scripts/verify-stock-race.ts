/**
 * STOCK RACE PROOF (supabase/migrations/00037, lib/stock.ts), on production.
 *
 *   npx tsx scripts/verify-stock-race.ts
 *
 * Every call is a separate HTTP request = a separate Postgres transaction, fired
 * at the same moment, against a HIDDEN fixture product on test4 (never on sale):
 *   - 12 buyers, 5 units: exactly 5 holds, 7 refusals; nothing sold yet.
 *   - the same payment delivered 6 times at once: applied exactly once.
 *   - a recount racing 4 sales: the movement history is an unbroken chain
 *     (each level = previous + change, the last = on hand): no lost update.
 *   - an expired hold and a released hold give their unit back.
 *   - store B, and the public anon key, can change nothing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';

const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const FIXTURE = { id: 'prod_stock_race', slug: 'stock-race-fixture', size: 'One' };
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { resolveVariantId } = await import('../lib/inventory');
  const { writeProductToPostgres } = await import('../lib/catalog-write');
  const stock = await import('../lib/stock');
  const sc: any = await import('../services/config/supabase-client');
  const run = 'race-' + Date.now().toString(36);
  const keys: string[] = [];

  // The fixture: hidden (not on sale, not upcoming), so no shopper sees it.
  let variantId = await resolveVariantId(A, FIXTURE.id, FIXTURE.size);
  if (!variantId) {
    const w = await writeProductToPostgres(A, {
      id: FIXTURE.id, name: 'Stock race fixture (hidden)', slug: FIXTURE.slug, tagline: '', desc: '',
      isActive: false, isArchived: false, isUpcoming: false, checkoutMode: 'FCFS', productType: 'fcfs', isRaffle: false,
      maxPerEmail: 1, maxPerCart: 1, releaseEndsAt: '', totalInventory: 0, inventoryPerSize: { [FIXTURE.size]: 0 },
      priceCategories: [{ size: FIXTURE.size, price: 1, checkoutMode: 'FCFS' }], notes: [], images: [], categories: [],
    } as any);
    if (!w.ok) throw new Error('fixture: ' + w.error);
    variantId = await resolveVariantId(A, FIXTURE.id, FIXTURE.size);
  }
  if (!variantId) throw new Error('no fixture variant');
  const v = String(variantId);
  const level = async () => (await stock.stockLevels(A, [v])).get(v)!;
  const hold = (key: string, ttl: number | null = 300) => { keys.push(key); return stock.reserveStock(A, key, [{ variantId: v, quantity: 1 }], ttl, run); };

  try {
    console.log('\nFixture reset to 5 on hand (a count)');
    const reset = await stock.setStock(A, v, 5, 'verify-stock-race', run);
    const l0 = await level();
    check(reset.ok && l0.onHand === 5 && l0.available === 5, 'on hand 5, available 5: ' + JSON.stringify(l0));

    console.log('\n12 buyers at once, 5 units');
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => hold(run + '-buyer-' + i)));
    const won = results.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
    const refused = results.filter((r) => !r.ok && r.reason === 'insufficient').length;
    check(won.length === 5 && refused === 7, 'exactly 5 holds and 7 refusals: ' + won.length + ' / ' + refused);
    const l1 = await level();
    check(l1.onHand === 5 && l1.held === 5 && l1.available === 0, 'nothing sold yet; all 5 held: ' + JSON.stringify(l1));

    console.log('\nThe same payment delivered 6 times at once');
    const first = run + '-buyer-' + won[0];
    const dup = await Promise.all(Array.from({ length: 6 }, () => stock.commitSale(A, first, [{ variantId: v, quantity: 1 }], run + '-pi-0')));
    const applied = dup.filter((d) => d[0]?.applied).length;
    check(applied === 1, 'applied exactly once: ' + applied + ' of 6');
    const l2 = await level();
    check(l2.onHand === 4 && l2.held === 4, 'on hand 4, 4 still held: ' + JSON.stringify(l2));

    console.log('\nA recount (10) racing the other 4 sales');
    const racers = await Promise.all([
      ...won.slice(1).map((i, n) => stock.commitSale(A, run + '-buyer-' + i, [{ variantId: v, quantity: 1 }], run + '-pi-' + (n + 1))),
      stock.setStock(A, v, 10, 'verify-stock-race', run + ' recount'),
    ]);
    check(racers.slice(0, 4).every((r: any) => r[0]?.applied), 'all 4 sales applied');
    const moves = (await getDb().select<any>('stock_movements', { where: { tenant_id: eq(A), variant_id: eq(v) }, select: ['id', 'reason', 'delta', 'quantity_after', 'reference'], order: { column: 'id', ascending: true } })) as any[];
    let chain = true;
    for (let i = 1; i < moves.length; i++) if (moves[i].quantity_after !== moves[i - 1].quantity_after + moves[i].delta) chain = false;
    const l3 = await level();
    check(chain && moves[moves.length - 1].quantity_after === l3.onHand, 'history is an unbroken chain ending at on hand ' + l3.onHand + ' (' + moves.length + ' movements): no lost update');
    const runSales = moves.filter((m) => m.reason === 'sale' && String(m.reference).startsWith(run)).length;
    check(runSales === 5 && l3.held === 0, '5 sales recorded, no holds left: ' + runSales + ', held ' + l3.held);

    console.log('\nHolds give their unit back');
    const onHand = l3.onHand;
    await hold(run + '-short', 1);
    await sleep(2500);
    check((await level()).available === onHand, 'an expired hold no longer counts');
    await hold(run + '-released');
    const during = (await level()).available;
    await stock.releaseStock(A, run + '-released');
    check(during === onHand - 1 && (await level()).available === onHand, 'a released hold gives its unit back');

    console.log('\nNobody else can touch it');
    const bReserve = await stock.reserveStock(B, run + '-b', [{ variantId: v, quantity: 1 }], 300);
    const bSet = await stock.setStock(B, v, 999, 'store-b');
    const bAdjust = await stock.adjustStock(B, v, 999, 'restock', 'store-b');
    check(!bReserve.ok && bReserve.reason === 'no_stock_row' && !bSet.ok && !bAdjust.ok && (await level()).onHand === onHand, 'store B: no such stock (reserve, count, adjust); test4 unchanged');
    const { url, anonKey } = sc.readSupabaseEnv();
    const anon = await fetch(url.replace(/\/$/, '') + '/rest/v1/rpc/stock_set', {
      method: 'POST', headers: { apikey: anonKey, authorization: 'Bearer ' + anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_tenant: A, p_variant: v, p_count: 999, p_actor: 'anon', p_note: null }),
    });
    const anonRead = await fetch(url.replace(/\/$/, '') + '/rest/v1/stock_levels?select=*', { headers: { apikey: anonKey, authorization: 'Bearer ' + anonKey } });
    const anonRows = anonRead.ok ? await anonRead.json() : null;
    check(!anon.ok && (await level()).onHand === onHand, 'the public anon key cannot call stock_set: HTTP ' + anon.status);
    check(!anonRead.ok || (Array.isArray(anonRows) && anonRows.length === 0), 'nor read stock levels: HTTP ' + anonRead.status);
  } finally {
    for (const k of keys) await stock.releaseStock(A, k).catch(() => 0);
    await stock.setStock(A, v, 0, 'verify-stock-race', run + ' cleanup').catch(() => null);
    console.log('\nholds released, fixture back to 0');
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.message || e); process.exit(1); });
