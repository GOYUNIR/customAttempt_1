/**
 * TENANT CHECKOUT, END TO END (TENANCY.md phase 2, CONNECT.md §7).
 *
 *   npx tsx scripts/verify-tenant-checkout.ts [card] [--refund]
 *     card: 4242424242424242 (default) | 4000000000000259 (creates a dispute)
 *
 * A shopper's real journey on a merchant's own address, driven in Chrome at
 * phone width: product page -> size -> email -> address picked from the
 * dropdown -> buy -> Stripe's hosted page on the MERCHANT's account -> test
 * card -> back to the store. Then every record is read back, never asserted:
 *   Stripe:   the session and PaymentIntent live on the merchant's account;
 *             application_fee_amount = platformFeeForCharge at that moment;
 *             the platform received that fee.
 *   Database: an order for THIS tenant with that fee and currency; exactly one
 *             tenant_billing_charges row; stock down by one; the webhook event
 *             processed once; nothing written for the default store.
 * --refund: refund it from the MERCHANT's side without returning our fee (as
 *   their Stripe Dashboard would), then prove the webhook returned the fee
 *   exactly (D5) and took the sale off the month's running total.
 * With the dispute card: the dispute lands on the merchant; our fee is kept (T11).
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true'; // as production runs

import { chromium } from 'playwright-core';
import { CHROME, IPHONE_UA } from './mobile-audit';

const TENANT = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const STORE = process.env.TENANT_STORE_URL || 'https://test4.goyunir.com';
const PRODUCT_SLUG = 'connect-test-item';
const PRODUCT_ID = 'prod_tenant_test_1';
const SIZE = 'One Size';
const CARD = process.argv.slice(2).find((a) => /^\d{16}$/.test(a)) || '4242424242424242';
const REFUND = process.argv.includes('--refund');
const OUT = join(process.cwd(), 'tenant-checkout-out');

let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stockNow(getDb: any, eq: any, resolveVariantId: any): Promise<number | null> {
  const variantId = await resolveVariantId(TENANT, PRODUCT_ID, SIZE);
  if (!variantId) return null;
  const row = ((await getDb().select('inventory_levels', { where: { tenant_id: eq(TENANT), variant_id: eq(variantId) }, select: ['quantity_available'], limit: 1 })) as any[])[0];
  return row ? Number(row.quantity_available) : null;
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
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

  const stockBefore = await stockNow(getDb, eq, resolveVariantId);
  const volumeBefore = await billingMonthVolume(TENANT);
  const expectedFee = (await platformFeeForCharge(TENANT, 1900)).feeCents;
  console.log('before: stock ' + stockBefore + ', month volume ' + volumeBefore + ', expected fee on $19.00: ' + expectedFee + ', card ' + CARD);

  // ── the shopper's journey ──────────────────────────────────────────────────
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  await ctx.addInitScript('window.__name = function (f) { return f; };');
  const page = await ctx.newPage();
  const email = 'tenant-checkout-' + Date.now() + '@goyunir.invalid';
  let sessionId = '';
  try {
    await page.goto(STORE + '/' + PRODUCT_SLUG, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: new RegExp(SIZE, 'i') }).first().tap({ timeout: 10_000 }).catch(() => {});
    const emailInput = page.locator('input[type=email], input[placeholder*=email i]').first();
    await emailInput.tap({ timeout: 10_000 });
    await emailInput.fill(email);
    const addr = page.locator('input[placeholder*=address i], input[autocomplete*=address i]').first();
    await addr.tap({ timeout: 10_000 });
    await addr.pressSequentially('1600 Pennsylvania Avenue', { delay: 90 });
    const option = page.locator('[role=option]').first();
    await option.waitFor({ state: 'visible', timeout: 15_000 });
    await option.tap();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, '1-product.png') });
    const buy = page.locator('.goyunir-pdp-cta-bar button').first();
    console.log('buy button: "' + (await buy.innerText()).trim() + '"');
    await buy.tap({ timeout: 10_000 });
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    sessionId = (/(cs_test_[A-Za-z0-9]+)/.exec(page.url()) || [])[1] || '';
    console.log('on Stripe checkout, session ' + sessionId);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(OUT, '2-stripe.png') });

    const fillIf = async (sel: string, value: string) => {
      const l = page.locator(sel).first();
      if (await l.isVisible().catch(() => false)) { await l.fill(value); return true; }
      return false;
    };
    await fillIf('#email', email);
    await page.locator('#cardNumber').first().fill(CARD, { timeout: 20_000 });
    await fillIf('#cardExpiry', '12 / 34');
    await fillIf('#cardCvc', '123');
    await fillIf('#billingName', 'Test Buyer');
    await fillIf('#billingPostalCode', '94103');
    // Stripe Link's 'Save my information' is ticked by default and then
    // requires a phone number; a shopper who doesn't want Link unticks it.
    const link = page.getByLabel(/Save my information/i).first();
    if (await link.isChecked().catch(() => false)) await link.uncheck({ force: true }).catch(() => {});
    await page.screenshot({ path: join(OUT, '3-filled.png') });
    await page.locator('button[type=submit], .SubmitButton').first().click({ timeout: 10_000 });
    await page.waitForURL(new RegExp(STORE.replace(/[.]/g, '\\.') + '/.*purchase=success'), { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(OUT, '4-back.png') });
    const back = page.url();
    const toast = await page.getByText(/Purchase complete/i).first().isVisible().catch(() => false);
    check(back.startsWith(STORE), 'returned to the merchant\'s address: ' + back.slice(0, 80) + (toast ? ' ("Purchase complete" shown)' : ''));
  } finally {
    await browser.close();
  }
  if (!sessionId) throw new Error('never reached Stripe checkout');

  // ── read everything back ───────────────────────────────────────────────────
  console.log('\nStripe');
  const session = await stripe.checkout.sessions.retrieve(sessionId, {}, on);
  check(session.payment_status === 'paid', 'session ' + sessionId + ' is paid on ' + acct);
  const onPlatform = await stripe.checkout.sessions.retrieve(sessionId).then(() => true).catch(() => false);
  check(!onPlatform, 'the session does NOT exist on the platform account');
  const pi = await stripe.paymentIntents.retrieve(String(session.payment_intent), {}, on);
  check(pi.application_fee_amount === expectedFee, 'application_fee_amount ' + pi.application_fee_amount + ' = expected ' + expectedFee);
  check(pi.metadata?.tenant_id === TENANT, 'PaymentIntent carries tenant_id');
  let fee: any = null;
  for (let i = 0; i < 20 && !fee; i++) {
    const ch = await stripe.charges.retrieve(String(pi.latest_charge), {}, on);
    if (ch.application_fee) fee = await stripe.applicationFees.retrieve(String(ch.application_fee)); else await sleep(1000);
  }
  check(Boolean(fee) && fee.amount === expectedFee && fee.account === acct, 'platform received fee ' + (fee ? fee.id + ' ' + fee.amount : '(none)'));

  console.log('\nDatabase (waiting for the webhook)');
  const orderRef = String(session.metadata?.orderRef || '');
  let order: any = null;
  for (let i = 0; i < 30 && !order; i++) {
    order = ((await getDb().select('orders', { where: { tenant_id: eq(TENANT), order_ref: eq(orderRef) }, select: ['id', 'order_ref', 'total_cents', 'currency', 'platform_fee_cents', 'payment_status', 'stripe_payment_intent_id', 'checkout_mode'], limit: 1 })) as any[])[0] || null;
    if (!order) await sleep(2000);
  }
  check(Boolean(order), 'order ' + orderRef + ' written for test4: ' + JSON.stringify(order));
  if (order) {
    check(order.total_cents === 1900 && order.platform_fee_cents === expectedFee && order.currency === String(session.currency) && order.stripe_payment_intent_id === pi.id,
      'order total 1900, platform_fee_cents ' + order.platform_fee_cents + ', currency ' + order.currency + ', PaymentIntent matches');
  }
  const billing = (await getDb().select('tenant_billing_charges', { where: { payment_intent_id: eq(pi.id) } }).catch(async () =>
    getDb().select('tenant_billing_charges', { where: { stripe_payment_intent_id: eq(pi.id) } }))) as any[];
  check(billing.length === 1 && billing[0].tenant_id === TENANT, 'exactly one tenant_billing_charges row: ' + JSON.stringify(billing));
  const stockAfter = await stockNow(getDb, eq, resolveVariantId);
  check(stockBefore !== null && stockAfter === stockBefore - 1, 'stock ' + stockBefore + ' -> ' + stockAfter);
  const volumeAfter = await billingMonthVolume(TENANT);
  check(volumeAfter === volumeBefore + 1900, 'month volume ' + volumeBefore + ' -> ' + volumeAfter);
  const defaultOrders = (await getDb().select('orders', { where: { tenant_id: eq(DEFAULT_TENANT_ID), stripe_payment_intent_id: eq(pi.id) } })) as any[];
  check(defaultOrders.length === 0, 'nothing written for the default store');
  const events = await stripe.events.list({ type: 'checkout.session.completed', created: { gte: Math.floor(Date.now() / 1000) - 900 }, limit: 10 }, on);
  const ev = events.data.find((e: any) => e.data?.object?.id === sessionId);
  const dd = ev ? ((await getDb().select('webhook_dedupe', { where: { scope: eq('stripe_connect_event'), dedupe_key: eq(ev.id) } })) as any[]) : [];
  check(Boolean(ev) && ev.pending_webhooks === 0 && dd.length === 1 && dd[0].status === 'done', 'webhook event ' + (ev?.id || '?') + ' delivered and processed once');

  if (CARD === '4000000000000259') {
    console.log('\nDispute');
    let dispute: any = null;
    for (let i = 0; i < 30 && !dispute; i++) { dispute = (await stripe.disputes.list({ payment_intent: pi.id, limit: 1 }, on)).data[0] || null; if (!dispute) await sleep(2000); }
    check(Boolean(dispute), 'dispute ' + (dispute?.id || 'never appeared') + ' on the merchant account');
    const platformHas = dispute ? await stripe.disputes.retrieve(dispute.id).then(() => true).catch(() => false) : true;
    check(!platformHas, 'the dispute does NOT exist on the platform account');
    await sleep(5000);
    const f2 = fee ? await stripe.applicationFees.retrieve(fee.id) : null;
    check(Boolean(f2) && f2.amount_refunded === 0, 'our fee is kept on the dispute (T11): refunded ' + (f2 ? f2.amount_refunded : '?'));
  }

  if (REFUND) {
    console.log('\nRefund from the merchant side (our fee NOT returned by the refund call)');
    const refund = await stripe.refunds.create({ payment_intent: pi.id }, on);
    check(refund.status === 'succeeded' || refund.status === 'pending', 'refund ' + refund.id + ' ' + refund.status);
    let f3: any = null;
    for (let i = 0; i < 30; i++) { f3 = await stripe.applicationFees.retrieve(fee.id); if (f3.amount_refunded === fee.amount) break; await sleep(2000); }
    check(f3.amount_refunded === fee.amount, 'the webhook returned our fee exactly: ' + f3.amount_refunded + ' of ' + fee.amount + ' (D5)');
    let volumeRefunded = await billingMonthVolume(TENANT);
    for (let i = 0; i < 15 && volumeRefunded !== volumeBefore; i++) { await sleep(2000); volumeRefunded = await billingMonthVolume(TENANT); }
    check(volumeRefunded === volumeBefore, 'month volume back to ' + volumeRefunded + ' (was ' + volumeBefore + ')');
  }

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.raw?.message || e?.message || e); process.exit(1); });
