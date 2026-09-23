/**
 * CART ORDER WRITES — one payment, one order, every line.
 *
 *   npm run verify:cart-orders
 *
 * WHY THIS EXISTS SEPARATELY FROM verify-order-write.ts. That script checks
 * lib/order-write.ts's contract and passes 19 checks, every one of them about a
 * SINGLE-LINE order. The webhook's cart branch called recordOrder once per cart
 * item with the one order_ref from the session metadata; orders upsert on
 * (tenant_id, order_ref) and their line items are replaced rather than
 * appended, so each item erased the one before it.
 *
 * Measured against the real catalog before the fix: Roccstar 50ml ($19) plus
 * Black Solstice 50ml x2 ($50) charged $69 and recorded ONE order of $50 with
 * ONE Black Solstice line. The $19 product was not in the order at all — not as
 * revenue, and not as anything a fulfilment screen could tell you to ship.
 *
 * A single-item cart was always correct, which is exactly why every existing
 * check passed. So the thing this asserts is the thing none of them did: that a
 * cart of MORE THAN ONE item survives being recorded.
 *
 * WHAT IT WRITES, and cleans up: orders, order_line_items and a customer row
 * for an @goyunir.invalid address.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadEnv() {
  const p = join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();
process.env.USE_POSTGRES_PRIMARY = 'true';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const STAMP = Date.now().toString(36);
const EMAIL = 'cart-' + STAMP + '@goyunir.invalid';
const REF = 'VERIFY-CART-' + STAMP;
const SINGLE_REF = 'VERIFY-ONE-' + STAMP;

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { recordOrder } = await import('../lib/order-write');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }
  const tenantId = await ensureDefaultTenant();

  console.log('\nCart order writes — a multi-item cart is one order with every line');
  console.log('='.repeat(74));
  console.log('tenant: ' + tenantId + '\n');

  // Two DISTINCT sellable lines from the real catalog, so variant linking is
  // exercised per line rather than asserted.
  const products = (await db.select<{ id: string; external_id: string; name: string }>('products', {
    where: { tenant_id: eq(tenantId) }, select: ['id', 'external_id', 'name'], limit: 5,
  })) as Array<{ id: string; external_id: string; name: string }>;
  if (products.length === 0) { console.error('No catalog rows to sell.'); process.exit(2); }

  const variantsOf = async (productId: string) =>
    (await db.select<{ id: string; option_label: string }>('product_variants', {
      where: { product_id: eq(productId) }, select: ['id', 'option_label'], limit: 5,
    })) as Array<{ id: string; option_label: string }>;

  const vA = await variantsOf(products[0].id);
  let lineA: { ext: string; name: string; size: string };
  let lineB: { ext: string; name: string; size: string };
  if (products.length >= 2) {
    const vB = await variantsOf(products[1].id);
    lineA = { ext: products[0].external_id, name: products[0].name, size: vA[0]?.option_label || 'Standard' };
    lineB = { ext: products[1].external_id, name: products[1].name, size: vB[0]?.option_label || 'Standard' };
  } else {
    if (vA.length < 2) { console.error('Need two distinct sellable lines.'); process.exit(2); }
    lineA = { ext: products[0].external_id, name: products[0].name, size: vA[0].option_label };
    lineB = { ext: products[0].external_id, name: products[0].name, size: vA[1].option_label };
  }

  const A_CENTS = 1900;   // 1 x 1900
  const B_CENTS = 5000;   // 2 x 2500
  const CART_TOTAL = A_CENTS + B_CENTS;
  const cartLines = [
    { externalProductId: lineA.ext, productName: lineA.name, size: lineA.size, quantity: 1, amountCents: A_CENTS },
    { externalProductId: lineB.ext, productName: lineB.name, size: lineB.size, quantity: 2, amountCents: B_CENTS },
  ];
  console.log('cart: ' + lineA.name + '/' + lineA.size + ' x1 ($' + (A_CENTS / 100).toFixed(2) + ')'
    + ' + ' + lineB.name + '/' + lineB.size + ' x2 ($' + (B_CENTS / 100).toFixed(2) + ')');
  console.log('the customer is charged $' + (CART_TOTAL / 100).toFixed(2) + '\n');

  const ordersFor = async (ref: string) =>
    (await db.select<Record<string, unknown>>('orders', {
      where: { tenant_id: eq(tenantId), order_ref: eq(ref) },
      select: ['id', 'order_ref', 'total_cents', 'subtotal_cents', 'payment_status', 'metadata'], limit: 10,
    })) as Array<Record<string, unknown>>;
  const linesFor = async (orderId: string) =>
    (await db.select<Record<string, unknown>>('order_line_items', {
      where: { tenant_id: eq(tenantId), order_id: eq(orderId) },
      select: ['id', 'variant_id', 'quantity', 'unit_price_cents', 'line_total_cents'], limit: 20,
    })) as Array<Record<string, unknown>>;

  // ── 1. the whole cart is recorded ───────────────────────────────────────
  console.log('1. Recording a two-item cart');
  const first = await recordOrder({
    tenantId, orderRef: REF, email: EMAIL, lines: cartLines,
    checkoutMode: 'fcfs', stripePaymentIntentId: 'pi_cart_' + STAMP,
  });
  check(first.ok, 'the cart is recorded', JSON.stringify(first));
  if (!first.ok) { console.log('cannot continue'); process.exit(1); }
  check(first.variantLinked, 'every line resolved to a variant');

  const orders = await ordersFor(REF);
  check(orders.length === 1, 'exactly one order for one payment', 'orders=' + orders.length);
  const orderId = String(orders[0]?.id);

  // THE REGRESSION. Before the fix this was B_CENTS — the last line only.
  check(Number(orders[0]?.total_cents) === CART_TOTAL,
    'the order total is the whole cart, not the last line',
    'got ' + orders[0]?.total_cents + ', expected ' + CART_TOTAL);
  check(Number(orders[0]?.subtotal_cents) === CART_TOTAL,
    'and the subtotal agrees', JSON.stringify(orders[0]?.subtotal_cents));

  const items = await linesFor(orderId);
  check(items.length === 2, 'both cart items are line items', 'lines=' + items.length);
  check(items.every((i) => i.variant_id), 'each line says which variant was sold',
    JSON.stringify(items.map((i) => i.variant_id)));
  check(items.reduce((s, i) => s + Number(i.line_total_cents || 0), 0) === CART_TOTAL,
    'the lines sum to what was charged',
    JSON.stringify(items.map((i) => i.line_total_cents)));

  const variantIds = new Set(items.map((i) => String(i.variant_id)));
  check(variantIds.size === 2, 'the two lines are different variants, not one written twice',
    JSON.stringify([...variantIds]));
  const qtyTwo = items.find((i) => Number(i.quantity) === 2);
  check(Boolean(qtyTwo), 'the quantity-2 line kept its quantity');
  check(Number(qtyTwo?.unit_price_cents) === B_CENTS / 2,
    'and its unit price is the line total divided by quantity',
    JSON.stringify(qtyTwo?.unit_price_cents));

  // ── 2. a webhook retry must not double or truncate it ───────────────────
  console.log('\n2. Stripe redelivers the same event');
  const replay = await recordOrder({
    tenantId, orderRef: REF, email: EMAIL, lines: cartLines,
    checkoutMode: 'fcfs', stripePaymentIntentId: 'pi_cart_' + STAMP,
  });
  check(replay.ok && replay.orderId === orderId, 'the retry updates the same order',
    JSON.stringify(replay));
  const afterOrders = await ordersFor(REF);
  check(afterOrders.length === 1, 'still one order', 'orders=' + afterOrders.length);
  check(Number(afterOrders[0]?.total_cents) === CART_TOTAL, 'still the full cart total',
    JSON.stringify(afterOrders[0]?.total_cents));
  const afterItems = await linesFor(orderId);
  check(afterItems.length === 2, 'still two lines — not four, not one', 'lines=' + afterItems.length);

  // ── 3. metadata describes the cart, not just its first line ─────────────
  console.log('\n3. The order metadata describes the whole cart');
  const meta = (afterOrders[0]?.metadata || {}) as Record<string, unknown>;
  const metaLines = Array.isArray(meta.lines) ? meta.lines : [];
  check(metaLines.length === 2, 'metadata carries both lines', JSON.stringify(meta.lines));

  // ── 4. the single-line callers are unchanged ────────────────────────────
  console.log('\n4. The single-line shape still works (direct checkout, raffle draw)');
  const single = await recordOrder({
    tenantId, orderRef: SINGLE_REF, email: EMAIL,
    externalProductId: lineA.ext, productName: lineA.name, size: lineA.size,
    quantity: 1, amountCents: A_CENTS,
    checkoutMode: 'fcfs', stripePaymentIntentId: 'pi_single_' + STAMP,
  });
  check(single.ok, 'a one-item sale is recorded', JSON.stringify(single));
  const singleOrders = await ordersFor(SINGLE_REF);
  check(Number(singleOrders[0]?.total_cents) === A_CENTS, 'with the right total',
    JSON.stringify(singleOrders[0]?.total_cents));
  const singleItems = await linesFor(String(singleOrders[0]?.id));
  check(singleItems.length === 1, 'and exactly one line', 'lines=' + singleItems.length);
  check(Boolean(singleItems[0]?.variant_id), 'carrying its variant_id');

  // ── cleanup ─────────────────────────────────────────────────────────────
  for (const ref of [REF, SINGLE_REF]) {
    for (const o of await ordersFor(ref)) {
      await db.remove('order_line_items', { where: { tenant_id: eq(tenantId), order_id: eq(String(o.id)) } });
      await db.remove('orders', { where: { tenant_id: eq(tenantId), id: eq(String(o.id)) } });
    }
  }
  await db.remove('customers', { where: { tenant_id: eq(tenantId), email: eq(EMAIL) } });

  console.log('\n' + '='.repeat(74));
  console.log(fail === 0 ? 'All checks passed.' : fail + ' check(s) FAILED.');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
