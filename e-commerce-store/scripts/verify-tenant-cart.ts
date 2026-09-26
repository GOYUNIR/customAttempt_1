/**
 * TENANT CART CHECKOUT, END TO END (TENANCY.md phase 3).
 *
 *   npx tsx scripts/verify-tenant-cart.ts
 *
 * A shopper fills a bag on a merchant's own address (Chrome, phone width):
 * Connect Test Pair Large x1, Small x2, Connect Test Item x1 -- three lines,
 * two products, one quantity above one -- then checks out from the bag
 * drawer, pays on Stripe's hosted page (the MERCHANT's account) and returns.
 * Then everything is read back from Stripe and the database:
 *   one paid session with those three line items; fee = platformFeeForCharge
 *   on the cart total; ONE order carrying all three lines and the fee; one
 *   billing row; each line's stock down by its quantity; nothing for the
 *   default store; the webhook event processed once.
 * Then refunds from the MERCHANT's side (our fee not returned by the calls):
 *   a partial refund returns our fee in proportion (D5); refunding the rest
 *   returns the whole fee; the month's volume goes back to where it started.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';

import { chromium, type Page } from 'playwright-core';
import { CHROME, IPHONE_UA } from './mobile-audit';

const TENANT = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const STORE = process.env.TENANT_STORE_URL || 'https://test4.goyunir.com';
const BAG = [
  { slug: 'connect-test-pair', productId: 'prod_tenant_test_2', size: 'Large', qty: 1, unit: 2400 },
  { slug: 'connect-test-pair', productId: 'prod_tenant_test_2', size: 'Small', qty: 2, unit: 1200 },
  { slug: 'connect-test-item', productId: 'prod_tenant_test_1', size: 'One Size', qty: 1, unit: 1900 },
];
const TOTAL = BAG.reduce((s, l) => s + l.qty * l.unit, 0);
const OUT = join(process.cwd(), 'tenant-checkout-out');

let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function addToBag(page: Page, slug: string, size: string, times: number) {
  await page.goto(STORE + '/' + slug, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForTimeout(2500);
  for (let i = 0; i < times; i++) {
    await page.getByRole('button', { name: new RegExp('^' + size + '\\b', 'i') }).first().tap({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /add to (bag|cart)/i }).first().tap({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    // Adding can open the drawer; close it before the next add.
    const close = page.getByRole('button', { name: /^close$/i }).first();
    if (await close.isVisible().catch(() => false)) { await close.tap().catch(() => {}); await page.waitForTimeout(600); }
  }
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const { getDb } = await import('../lib/db/client');
  const { eq, inList } = await import('../lib/db/query');
  const { resolveVariantId } = await import('../lib/inventory');
  const { platformFeeForCharge, billingMonthVolume } = await import('../lib/billing');
  const { chargeRouteForTenant } = await import('../lib/connect');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const { DEFAULT_TENANT_ID } = await import('../lib/tenant-context');
  const stripe: any = await resolveStripeClient();
  const route = await chargeRouteForTenant(TENANT);
  if (route.route !== 'connected') throw new Error('test4 is not connected: ' + JSON.stringify(route));
  const acct = route.stripeAccount;
  const on = { stripeAccount: acct };

  const stockOf = async (productId: string, size: string) => {
    const v = await resolveVariantId(TENANT, productId, size);
    const row = v ? ((await getDb().select('inventory_levels', { where: { tenant_id: eq(TENANT), variant_id: eq(v) }, select: ['quantity_available'], limit: 1 })) as any[])[0] : null;
    return row ? Number(row.quantity_available) : null;
  };
  const stockBefore = await Promise.all(BAG.map((l) => stockOf(l.productId, l.size)));
  const volumeBefore = await billingMonthVolume(TENANT);
  const expectedFee = (await platformFeeForCharge(TENANT, TOTAL)).feeCents;
  console.log('before: stock ' + JSON.stringify(stockBefore) + ', month volume ' + volumeBefore + ', cart ' + TOTAL + ', expected fee ' + expectedFee);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  await ctx.addInitScript('window.__name = function (f) { return f; };');
  const page = await ctx.newPage();
  const email = 'tenant-cart-' + Date.now() + '@goyunir.invalid';
  let sessionId = '';
  try {
    await addToBag(page, 'connect-test-pair', 'Large', 1);
    await addToBag(page, 'connect-test-pair', 'Small', 2);
    await addToBag(page, 'connect-test-item', 'One Size', 1);
    // Open the bag drawer.
    const review = page.getByRole('button', { name: /review prepared bag/i }).first();
    if (await review.isVisible().catch(() => false)) await review.tap();
    else await page.locator('header button[type=submit]').last().tap();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, 'cart-1-drawer.png') });
    const drawerEmail = page.locator('input[type=email]').last();
    await drawerEmail.tap({ timeout: 10_000 });
    await drawerEmail.fill(email);
    const addr = page.locator('input[placeholder*=address i], input[autocomplete*=address i]').last();
    await addr.tap({ timeout: 10_000 });
    await addr.pressSequentially('1600 Pennsylvania Avenue', { delay: 90 });
    const option = page.locator('[role=option]').first();
    await option.waitFor({ state: 'visible', timeout: 15_000 });
    await option.tap();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, 'cart-2-filled.png') });
    await page.getByRole('button', { name: /checkout now/i }).first().tap({ timeout: 10_000 });
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    sessionId = (/(cs_test_[A-Za-z0-9]+)/.exec(page.url()) || [])[1] || '';
    console.log('on Stripe checkout, session ' + sessionId);
    await page.waitForTimeout(3000);
    const fillIf = async (sel: string, value: string) => { const l = page.locator(sel).first(); if (await l.isVisible().catch(() => false)) await l.fill(value); };
    await fillIf('#email', email);
    await page.locator('#cardNumber').first().fill('4242424242424242', { timeout: 20_000 });
    await fillIf('#cardExpiry', '12 / 34');
    await fillIf('#cardCvc', '123');
    await fillIf('#billingName', 'Test Buyer');
    await fillIf('#billingPostalCode', '94103');
    const link = page.getByLabel(/Save my information/i).first();
    if (await link.isChecked().catch(() => false)) await link.uncheck({ force: true }).catch(() => {});
    await page.screenshot({ path: join(OUT, 'cart-3-stripe.png'), fullPage: true });
    await page.locator('button[type=submit], .SubmitButton').first().click({ timeout: 10_000 });
    await page.waitForURL(new RegExp(STORE.replace(/[.]/g, '\\.') + '/.*purchase=success'), { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(OUT, 'cart-4-back.png') });
    const back = page.url();
    const toast = await page.getByText(/Purchase complete/i).first().isVisible().catch(() => false);
    check(back.startsWith(STORE), 'returned to the merchant\'s address: ' + back.slice(0, 80) + (toast ? ' ("Purchase complete" shown)' : ''));
  } finally {
    await browser.close();
  }
  if (!sessionId) throw new Error('never reached Stripe checkout');

  console.log('\nStripe');
  const session = await stripe.checkout.sessions.retrieve(sessionId, {}, on);
  check(session.payment_status === 'paid' && session.amount_total === TOTAL, 'session paid on ' + acct + ', amount ' + session.amount_total + ' = cart ' + TOTAL);
  const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 20 }, on);
  check(items.data.length === 3, 'three line items: ' + items.data.map((i: any) => i.description + ' x' + i.quantity + ' = ' + i.amount_total).join('; '));
  const onPlatform = await stripe.checkout.sessions.retrieve(sessionId).then(() => true).catch(() => false);
  check(!onPlatform, 'the session does NOT exist on the platform account');
  const pi = await stripe.paymentIntents.retrieve(String(session.payment_intent), {}, on);
  check(pi.application_fee_amount === expectedFee, 'application_fee_amount ' + pi.application_fee_amount + ' = expected ' + expectedFee + ' (on the cart total)');
  let fee: any = null;
  for (let i = 0; i < 20 && !fee; i++) {
    const ch = await stripe.charges.retrieve(String(pi.latest_charge), {}, on);
    if (ch.application_fee) fee = await stripe.applicationFees.retrieve(String(ch.application_fee)); else await sleep(1000);
  }
  check(Boolean(fee) && fee.amount === expectedFee, 'platform received fee ' + (fee ? fee.id + ' ' + fee.amount : '(none)'));

  console.log('\nDatabase (waiting for the webhook)');
  const orderRef = String(session.metadata?.orderRef || '');
  let order: any = null;
  for (let i = 0; i < 30 && !order; i++) {
    order = ((await getDb().select('orders', { where: { tenant_id: eq(TENANT), order_ref: eq(orderRef) }, select: ['id', 'order_ref', 'total_cents', 'currency', 'platform_fee_cents', 'stripe_payment_intent_id'], limit: 1 })) as any[])[0] || null;
    if (!order) await sleep(2000);
  }
  check(Boolean(order) && order.total_cents === TOTAL && order.platform_fee_cents === expectedFee && order.stripe_payment_intent_id === pi.id,
    'ONE order ' + orderRef + ': ' + JSON.stringify(order));
  if (order) {
    const li = (await getDb().select('order_line_items', { where: { tenant_id: eq(TENANT), order_id: eq(order.id) }, select: ['variant_id', 'quantity', 'unit_price_cents', 'line_total_cents'] })) as any[];
    const variants = await Promise.all(BAG.map((l) => resolveVariantId(TENANT, l.productId, l.size)));
    const matches = BAG.every((l, i) => li.some((r) => r.variant_id === variants[i] && r.quantity === l.qty && r.unit_price_cents === l.unit && r.line_total_cents === l.qty * l.unit));
    check(li.length === 3 && matches, 'its three lines, each linked to its variant with the right quantity and price: ' + JSON.stringify(li));
  }
  const billing = (await getDb().select('tenant_billing_charges', { where: { payment_intent_id: eq(pi.id) } })) as any[];
  check(billing.length === 1 && billing[0].volume_cents === TOTAL && billing[0].fee_cents === expectedFee, 'exactly one billing row: ' + JSON.stringify(billing.map((b: any) => ({ v: b.volume_cents, f: b.fee_cents }))));
  const stockAfter = await Promise.all(BAG.map((l) => stockOf(l.productId, l.size)));
  // Two BAG rows share nothing, so each line's stock drops by its own quantity.
  check(BAG.every((l, i) => stockBefore[i] !== null && stockAfter[i] === (stockBefore[i] as number) - l.qty), 'stock ' + JSON.stringify(stockBefore) + ' -> ' + JSON.stringify(stockAfter));
  const volumeAfter = await billingMonthVolume(TENANT);
  check(volumeAfter === volumeBefore + TOTAL, 'month volume ' + volumeBefore + ' -> ' + volumeAfter);
  const defaultOrders = (await getDb().select('orders', { where: { tenant_id: eq(DEFAULT_TENANT_ID), stripe_payment_intent_id: eq(pi.id) } })) as any[];
  check(defaultOrders.length === 0, 'nothing written for the default store');
  const events = await stripe.events.list({ type: 'checkout.session.completed', created: { gte: Math.floor(Date.now() / 1000) - 900 }, limit: 10 }, on);
  const ev = events.data.find((e: any) => e.data?.object?.id === sessionId);
  const dd = ev ? ((await getDb().select('webhook_dedupe', { where: { scope: eq('stripe_connect_event'), dedupe_key: eq(ev.id) } })) as any[]) : [];
  check(Boolean(ev) && ev.pending_webhooks === 0 && dd.length === 1 && dd[0].status === 'done', 'webhook event ' + (ev?.id || '?') + ' delivered and processed once');

  console.log('\nRefunds from the merchant side');
  const partial = 2400; // the Large line
  const expectPartialFee = Math.round((fee.amount * partial) / TOTAL);
  await stripe.refunds.create({ payment_intent: pi.id, amount: partial }, on);
  let f1: any = null;
  for (let i = 0; i < 30; i++) { f1 = await stripe.applicationFees.retrieve(fee.id); if (f1.amount_refunded === expectPartialFee) break; await sleep(2000); }
  check(f1.amount_refunded === expectPartialFee, 'partial refund ' + partial + '/' + TOTAL + ' returned our fee in proportion: ' + f1.amount_refunded + ' (expected ' + expectPartialFee + ')');
  let v1 = await billingMonthVolume(TENANT);
  for (let i = 0; i < 15 && v1 !== volumeBefore + TOTAL - partial; i++) { await sleep(2000); v1 = await billingMonthVolume(TENANT); }
  check(v1 === volumeBefore + TOTAL - partial, 'month volume after partial refund: ' + v1);
  await stripe.refunds.create({ payment_intent: pi.id }, on);
  let f2: any = null;
  for (let i = 0; i < 30; i++) { f2 = await stripe.applicationFees.retrieve(fee.id); if (f2.amount_refunded === fee.amount) break; await sleep(2000); }
  check(f2.amount_refunded === fee.amount, 'refunding the rest returned the whole fee: ' + f2.amount_refunded + ' of ' + fee.amount);
  let v2 = await billingMonthVolume(TENANT);
  for (let i = 0; i < 15 && v2 !== volumeBefore; i++) { await sleep(2000); v2 = await billingMonthVolume(TENANT); }
  check(v2 === volumeBefore, 'month volume back to ' + v2 + ' (was ' + volumeBefore + ')');

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.raw?.message || e?.message || e); process.exit(1); });
