/**
 * ORDER WRITE VERIFICATION (orders cutover).
 *
 *   npm run verify:orders
 *
 * lib/order-write.ts replaced lib/postgres-shadow-write.ts, whose contract was
 * "best-effort, shadow only, never affects the real transaction". That was
 * right while nothing read the rows. Now a sale is RECORDED here, and the
 * card is already charged by the time it runs — so the things that must be
 * true are different:
 *
 *   - a webhook RETRY must not create a second order for one payment, and must
 *     not double the line items either (the shadow version upserted the order
 *     but appended lines)
 *   - the line must carry variant_id, so an order can say WHAT was sold.
 *     The shadow version never set it, which made per-variant revenue and
 *     inventory reconciliation impossible to compute from orders
 *   - the customer must come from the ONE identity path (lib/customers.ts), not
 *     a second parallel one
 *   - a failure must be REPORTED, not swallowed — silent failure here is money
 *     taken with no order behind it
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
const EMAIL = 'order-' + STAMP + '@goyunir.invalid';
const REF = 'VERIFY-' + STAMP;

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { recordOrder, findOrderByRef } = await import('../lib/order-write');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }
  const tenantId = await ensureDefaultTenant();

  console.log('\nOrder writes — a sale is recorded, once, with what was sold');
  console.log('='.repeat(74));
  console.log('tenant: ' + tenantId + '\n');

  // A real product/variant to link against, so variant_id is exercised for
  // real rather than asserted to be null.
  const products = (await db.select<{ id: string; external_id: string }>('products', {
    where: { tenant_id: eq(tenantId) }, select: ['id', 'external_id'], limit: 1,
  })) as Array<{ id: string; external_id: string }>;
  const variants = products[0]
    ? ((await db.select<{ id: string; option_label: string }>('product_variants', {
        where: { product_id: eq(products[0].id) }, select: ['id', 'option_label'], limit: 1,
      })) as Array<{ id: string; option_label: string }>)
    : [];
  const hasCatalog = Boolean(products[0] && variants[0]);
  console.log(hasCatalog
    ? 'linking against real product ' + products[0].external_id + ' / ' + variants[0].option_label + '\n'
    : 'no catalog rows to link against — variant linking will be checked as unlinked\n');

  const lineItemsFor = async (orderId: string) =>
    (await db.select<{ id: string; variant_id: string | null; quantity: number; line_total_cents: number }>(
      'order_line_items',
      { where: { tenant_id: eq(tenantId), order_id: eq(orderId) }, select: ['id', 'variant_id', 'quantity', 'line_total_cents'], limit: 20 },
    )) as Array<{ id: string; variant_id: string | null; quantity: number; line_total_cents: number }>;

  // ── 1. a sale is recorded ───────────────────────────────────────────────
  console.log('1. Recording a sale');
  const first = await recordOrder({
    tenantId,
    orderRef: REF,
    email: EMAIL,
    externalProductId: hasCatalog ? products[0].external_id : null,
    productName: 'Verification Product',
    size: hasCatalog ? variants[0].option_label : 'n/a',
    quantity: 2,
    amountCents: 9000,
    checkoutMode: 'FCFS',
    promoCode: null,
    stripePaymentIntentId: 'pi_verify_' + STAMP,
  });
  check(first.ok, 'the order is recorded', JSON.stringify(first));
  if (!first.ok) { console.log('cannot continue'); process.exit(1); }

  const order = await findOrderByRef(tenantId, REF) as Record<string, unknown> | null;
  check(order !== null, 'and is readable by its reference');
  check(order?.payment_status === 'paid', 'marked paid', JSON.stringify(order?.payment_status));
  check(order?.status === 'confirmed', 'and confirmed', JSON.stringify(order?.status));
  check(Number(order?.total_cents) === 9000, 'with the right total', JSON.stringify(order?.total_cents));
  check(order?.checkout_mode === 'fcfs',
    'checkout_mode normalised to the 00013 CHECK set (FCFS -> fcfs)', JSON.stringify(order?.checkout_mode));

  // The customer must come from the shared identity path.
  const customers = (await db.select<{ id: string }>('customers', {
    where: { tenant_id: eq(tenantId), email: eq(EMAIL) }, select: ['id'], limit: 5,
  })) as Array<{ id: string }>;
  check(customers.length === 1, 'exactly one customer row was created for the buyer', 'rows=' + customers.length);
  check(order?.customer_id === customers[0]?.id, 'and the order points at it', JSON.stringify(order?.customer_id));

  // ── 2. WHAT was sold ────────────────────────────────────────────────────
  console.log('\n2. The line item says what was sold');
  const lines = await lineItemsFor(String(order?.id));
  check(lines.length === 1, 'one line item', 'lines=' + lines.length);
  check(lines[0]?.quantity === 2, 'with the quantity', JSON.stringify(lines[0]?.quantity));
  check(lines[0]?.line_total_cents === 9000, 'and the line total', JSON.stringify(lines[0]?.line_total_cents));
  if (hasCatalog) {
    check(lines[0]?.variant_id === variants[0].id,
      'and variant_id is LINKED — the shadow writer never set this',
      'got ' + JSON.stringify(lines[0]?.variant_id) + ' want ' + variants[0].id);
    check(first.variantLinked === true, 'and the caller is told it linked', JSON.stringify(first.variantLinked));
  } else {
    check(first.variantLinked === false, 'and the caller is told it could NOT link', JSON.stringify(first.variantLinked));
  }

  // ── 3. THE RETRY ────────────────────────────────────────────────────────
  console.log('\n3. A retried webhook delivery (Stripe does this)');
  const replay = await recordOrder({
    tenantId,
    orderRef: REF,
    email: EMAIL,
    externalProductId: hasCatalog ? products[0].external_id : null,
    productName: 'Verification Product',
    size: hasCatalog ? variants[0].option_label : 'n/a',
    quantity: 2,
    amountCents: 9000,
    checkoutMode: 'FCFS',
    stripePaymentIntentId: 'pi_verify_' + STAMP,
  });
  check(replay.ok, 'the replay succeeds rather than erroring', JSON.stringify(replay));
  const allOrders = (await db.select<{ id: string }>('orders', {
    where: { tenant_id: eq(tenantId), order_ref: eq(REF) }, select: ['id'], limit: 10,
  })) as Array<{ id: string }>;
  check(allOrders.length === 1, 'and there is still exactly ONE order for the payment', 'orders=' + allOrders.length);
  const linesAfter = await lineItemsFor(String(order?.id));
  check(linesAfter.length === 1,
    'and still ONE line item — the shadow writer appended on every retry',
    'lines=' + linesAfter.length);
  const totalAfter = linesAfter.reduce((s, l) => s + Number(l.line_total_cents || 0), 0);
  check(totalAfter === 9000, 'so the order contents did not double', 'total=' + totalAfter);

  // ── 4. failures are reported, not swallowed ─────────────────────────────
  console.log('\n4. Failure is reported to the caller');
  const noRef = await recordOrder({
    tenantId, orderRef: '', email: EMAIL, productName: 'x', size: 'x', quantity: 1, amountCents: 100,
  });
  check(!noRef.ok, 'an order with no reference is refused', JSON.stringify(noRef));
  const badTenant = await recordOrder({
    tenantId: '00000000-0000-4000-8000-00000000dead',
    orderRef: 'VERIFY-BAD-' + STAMP, email: EMAIL, productName: 'x', size: 'x', quantity: 1, amountCents: 100,
  });
  check(!badTenant.ok,
    'a write against a non-existent tenant FAILS LOUDLY instead of returning silently',
    JSON.stringify(badTenant));

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up...');
  for (const o of allOrders) {
    try { await db.remove('order_line_items', { where: { tenant_id: eq(tenantId), order_id: eq(o.id) } }); } catch {}
    try { await db.remove('orders', { where: { tenant_id: eq(tenantId), id: eq(o.id) } }); } catch {}
  }
  try { await db.remove('orders', { where: { tenant_id: eq(tenantId), order_ref: eq('VERIFY-BAD-' + STAMP) } }); } catch {}
  try { await db.remove('customers', { where: { tenant_id: eq(tenantId), email: eq(EMAIL) } }); } catch {}

  const leftOrders = (await db.select<{ id: string }>('orders', {
    where: { tenant_id: eq(tenantId), order_ref: eq(REF) }, select: ['id'], limit: 5,
  })) as Array<{ id: string }>;
  const leftCustomers = (await db.select<{ id: string }>('customers', {
    where: { tenant_id: eq(tenantId), email: eq(EMAIL) }, select: ['id'], limit: 5,
  })) as Array<{ id: string }>;
  check(leftOrders.length === 0 && leftCustomers.length === 0,
    'test orders and customer removed',
    'orders=' + leftOrders.length + ' customers=' + leftCustomers.length);

  console.log('\n' + '='.repeat(74));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
