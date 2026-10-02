/**
 * DISCOUNT CODES, live (test-mode Stripe, sink-domain email): isolation,
 * abuse, the fee on the discounted total, Stripe's minimum, refund and expiry
 * interaction, and a real test-mode purchase with a code.
 *
 *   npx tsx scripts/verify-discounts.ts
 *
 * The plan flag is OFF in production. For this run only it is switched on for
 * test4's plan (only test and fixture stores exist) and put back afterwards,
 * along with every code the run made.
 */
import { ROOT } from './proof-config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const APP = 'https://app.' + ROOT;
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4 (Connect test store)
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
const STORE_A = 'https://test4.' + ROOT, STORE_B = 'https://goyunir-test-1.' + ROOT;
const PRODUCT = 'prod_tenant_test_1', SIZE = 'One Size';
const SINK = String(process.env.EMAIL_SINK_DOMAINS || '').split(',')[0].trim() || 'proof.invalid';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36).toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq, like } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const { platformFeeForCharge, tenantPlan } = await import('../lib/billing');
  const { chargeRouteForTenant } = await import('../lib/connect');
  const { sentTo } = await import('./resend-readback');
  const db = getDb(); const kv: any = createKvClient();
  const stripe: any = await resolveStripeClient();
  const route = await chargeRouteForTenant(A);
  if (route.route !== 'connected') throw new Error('test4 is not connected');
  const on = { stripeAccount: route.stripeAccount };
  const ownerA = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sA = (await issueAdminDevice(kv, ownerA, false, deviceMetaFor((await readStaffIdentity(ownerA))!), 900)).token;
  const sB = (await issueAdminDevice(kv, B_OWNER, false, deviceMetaFor((await readStaffIdentity(B_OWNER))!), 900)).token;
  const api = async (tok: string, method: string, body?: unknown) => {
    const r = await fetch(APP + '/api/merchant/discounts', { method, headers: { origin: APP, 'content-type': 'application/json', cookie: 'goyunir_admin_device=' + tok }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let b: any = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b };
  };
  const validate = async (store: string, code: string, email = '', subtotal = 19) =>
    (await fetch(store + '/api/promo/validate?code=' + encodeURIComponent(code) + '&email=' + encodeURIComponent(email) + '&orderSubtotal=' + subtotal)).json() as Promise<any>;
  const checkout = async (email: string, promoCode: string) => {
    const r = await fetch(STORE_A + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE_A }, body: JSON.stringify({ productId: PRODUCT, size: SIZE, email, address: '1600 Pennsylvania Avenue NW, Washington, DC 20500, United States', mode: 'direct', promoCode }) });
    const text = await r.text();
    let b: any = null; try { b = JSON.parse(text); } catch { /* */ }
    // Every non-200 is printed, so a failed check says what the store answered.
    if (r.status !== 200) console.log('     (checkout answered ' + r.status + ': ' + (b ? JSON.stringify(b) : text.replace(/\s+/g, ' ')).slice(0, 160) + ')');
    return { status: r.status, body: b };
  };
  const planA = (await tenantPlan(A)).id;
  const flagBefore = ((await db.select<any>('plans', { where: { id: eq(planA) }, select: ['discount_codes_enabled'], limit: 1 })) as any[])[0]?.discount_codes_enabled === true;
  const made: string[] = [];

  try {
    console.log('\nOff by default');
    check(flagBefore === false, 'the plan flag is off in production (' + planA + ')');
    check((await api(sA, 'GET')).body?.enabled === false, 'the dashboard says discounts are not on the plan');
    check((await api(sA, 'POST', { code: 'NOPE' + run.slice(-4), kind: 'percent', amount: 10 })).status === 403, 'creating a code is refused (403)');
    check((await checkout('off' + run.toLowerCase() + '@' + SINK, 'ANYCODE')).status === 409, 'checkout with a code is refused as before (409)');

    await db.update('plans', { where: { id: eq(planA) } }, { discount_codes_enabled: true }, { returning: 'minimal' } as any);
    await sleep(1500);
    // Stock for the purchases below (the fixture sells one unit per run).
    // Set, not added: the fixture's count stays the same however many runs.
    const { setStock } = await import('../lib/stock');
    const { resolveVariantId } = await import('../lib/inventory');
    const vid = await resolveVariantId(A, PRODUCT, SIZE);
    if (vid) await setStock(A, vid, 5, 'verify-discounts', 'proof fixture stock');

    console.log('\nCreating codes (test4) and isolation from store B');
    const TEN = 'TEN' + run.slice(-5);
    const c1 = await api(sA, 'POST', { code: TEN.toLowerCase(), kind: 'percent', amount: 10, maxUses: 2 });
    const tenId = String(c1.body?.id || ''); if (tenId) made.push(tenId);
    check(c1.status === 201 && c1.body.codes.some((c: any) => c.code === TEN), 'test4 makes ' + TEN + ' (10% off, 2 uses), stored upper-case');
    check(!(await api(sB, 'GET')).body?.codes?.some((c: any) => c.id === tenId), 'store B does not see it');
    check((await api(sB, 'POST', { id: tenId, active: false })).status === 404, 'store B cannot switch it off: 404');
    check((await validate(STORE_B, TEN)).valid === false, 'typed on store B\'s storefront: not valid');
    check((await validate(STORE_A, TEN)).valid === true && (await validate(STORE_A, TEN)).customerDiscountPercent === 10, 'on test4\'s storefront: valid, 10% off');
    const big = 'BIG' + run.slice(-5);
    const c2 = await api(sA, 'POST', { code: big, kind: 'fixed', amount: 50 }); if (c2.body?.id) made.push(String(c2.body.id));
    check(c2.status === 201, 'test4 makes ' + big + ' ($50 off a $19 item)');

    console.log('\nAbuse');
    const wrong = await validate(STORE_A, 'WRONG' + run.slice(-4));
    check(wrong.valid === false && wrong.error === "That code isn't valid.", 'a wrong code gets the one generic answer');
    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) limited = (await fetch(STORE_A + '/api/promo/validate?code=GUESS' + i + run.slice(-3))).status === 429;
    check(limited, 'guessing codes is rate-limited (429 within 35 tries)');
    check((await api(sA, 'POST', { code: 'BAD', kind: 'percent', amount: 95 })).status === 400, 'over 90% or a short code: refused (400)');

    console.log('\nStripe\'s minimum and the fee on the discounted total');
    const floor = await checkout('floor' + run.toLowerCase() + '@' + SINK, big);
    const fs = floor.body?.sessionId ? await stripe.checkout.sessions.retrieve(floor.body.sessionId, { expand: ['payment_intent'] }, on) : null;
    check(floor.status === 200 && fs?.amount_total === 50, '$50 off $19: charged $0.50, Stripe\'s minimum, never less (' + fs?.amount_total + ')');
    if (fs) await stripe.checkout.sessions.expire(fs.id, {}, on).catch(() => null);

    const buyer = 'disc' + run.toLowerCase() + '@' + SINK;
    const s1Started = Date.now();
    const s1 = await checkout(buyer, TEN);
    const session = s1.body?.sessionId ? await stripe.checkout.sessions.retrieve(s1.body.sessionId, { expand: ['line_items'] }, on) : null;
    const expectedFee = (await platformFeeForCharge(A, 1710)).feeCents;
    check(s1.status === 200 && session?.amount_total === 1710, '10% off $19.00: Stripe charges $17.10 (' + session?.amount_total + ')');
    check(String(session?.line_items?.data?.[0]?.description || '').includes(TEN), 'the line says which code: ' + session?.line_items?.data?.[0]?.description);
    check(String(session?.metadata?.platform_fee_cents) === String(expectedFee), 'our fee is on the DISCOUNTED total: ' + session?.metadata?.platform_fee_cents + ' = fee(1710) ' + expectedFee);

    console.log('\nPaying with the code (real test-mode checkout)');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      await page.goto(session.url, { waitUntil: 'load' });
      const fillIf = async (sel: string, v: string) => { const l = page.locator(sel).first(); if (await l.isVisible().catch(() => false)) await l.fill(v); };
      await fillIf('#email', buyer);
      await page.locator('#cardNumber').first().fill('4242424242424242', { timeout: 30_000 });
      await fillIf('#cardExpiry', '12 / 34'); await fillIf('#cardCvc', '123'); await fillIf('#billingName', 'Discount Buyer'); await fillIf('#billingPostalCode', '20500');
      const link = page.getByLabel(/Save my information/i).first();
      if (await link.isChecked().catch(() => false)) await link.uncheck({ force: true }).catch(() => {});
      await page.locator('button[type=submit], .SubmitButton').first().click({ timeout: 15_000 });
      await page.waitForURL(/purchase=success/, { timeout: 90_000 }).catch(() => {});
    } finally { await browser.close(); }
    const ref = String(session?.metadata?.orderRef || '');
    let order: any = null;
    for (let i = 0; i < 30 && !order; i++) { order = ((await db.select<any>('orders', { where: { tenant_id: eq(A), order_ref: eq(ref) }, select: ['id', 'subtotal_cents', 'discount_cents', 'total_cents', 'platform_fee_cents', 'stripe_payment_intent_id', 'metadata'], limit: 1 })) as any[])[0]; if (!order) await sleep(2000); }
    check(Boolean(order) && Number(order.subtotal_cents) === 1900 && Number(order.discount_cents) === 190 && Number(order.total_cents) === 1710 && order.metadata?.discountCode === TEN,
      'the order records it: subtotal 1900, discount 190, total 1710, code ' + order?.metadata?.discountCode);
    const pi = order ? await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, {}, on) : null;
    check(pi?.amount === 1710 && pi?.application_fee_amount === expectedFee && Number(order?.platform_fee_cents) === expectedFee, 'Stripe took $17.10 and our fee ' + pi?.application_fee_amount + ' (on the discounted total)');
    const red = ((await db.select<any>('discount_redemptions', { where: { tenant_id: eq(A), order_ref: eq(ref) }, select: ['status', 'discount_cents'] })) as any[]);
    check(red.length === 1 && red[0].status === 'redeemed' && Number(red[0].discount_cents) === 190, 'the use is redeemed, 190 given');
    const mail = (await sentTo(getDb, buyer, { waitMs: 20_000 })).find((m: any) => /Your order from/.test(m.subject));
    check(Boolean(mail) && String(mail.html).includes('Discount (' + TEN + ')'), 'the confirmation email shows the discount (recorded in the sink)');

    console.log('\nLimits after a purchase');
    // Checkout keys an attempt to a 30s window (a double tap reuses one hold,
    // one code use and one Stripe session). Inside the paid attempt's window
    // the same buyer gets that same, already-paid session back; the
    // per-customer rule applies to a NEW attempt, so wait for the next window.
    const paidWindow = Math.floor(s1Started / 30_000);
    if (Math.floor(Date.now() / 30_000) === paidWindow) {
      const replay = await checkout(buyer, TEN);
      check(replay.status === 200 && replay.body?.sessionId === s1.body?.sessionId, 'same window: the buyer gets their own paid session back, not a new discount');
      while (Math.floor(Date.now() / 30_000) === paidWindow) await sleep(1000);
    }
    check((await checkout(buyer, TEN)).body?.error === "That code isn't valid.", 'the same customer again: refused (1 per customer)');
    const s2 = await checkout('second' + run.toLowerCase() + '@' + SINK, TEN);
    check(s2.status === 200, 'a second customer: allowed (use 2 of 2, held)');
    check((await checkout('third' + run.toLowerCase() + '@' + SINK, TEN)).body?.error === "That code isn't valid.", 'a third customer while 2 of 2 are taken: refused');
    if (s2.body?.sessionId) {
      await stripe.checkout.sessions.expire(s2.body.sessionId, {}, on);
      let released = false;
      for (let i = 0; i < 20 && !released; i++) { released = ((await db.select<any>('discount_redemptions', { where: { tenant_id: eq(A), email: like('second%') }, select: ['status'] })) as any[]).some((r) => r.status === 'released'); if (!released) await sleep(1500); }
      check(released, 'that checkout expired unpaid: its use goes back (webhook)');
      check((await checkout('fourth' + run.toLowerCase() + '@' + SINK, TEN)).status === 200, 'so another customer can use it again');
    }

    console.log('\nRefund');
    if (pi) await stripe.refunds.create({ payment_intent: pi.id }, on);
    let refunded = false;
    for (let i = 0; i < 20 && !refunded; i++) { refunded = ((await db.select<any>('orders', { where: { id: eq(order.id) }, select: ['payment_status'] })) as any[])[0]?.payment_status === 'refunded'; if (!refunded) await sleep(1500); }
    const after = ((await db.select<any>('discount_redemptions', { where: { tenant_id: eq(A), order_ref: eq(ref) }, select: ['status'] })) as any[]);
    check(refunded && after[0]?.status === 'redeemed', 'refunded in Stripe: the order says refunded, the code\'s use stays used (decision 3)');
  } finally {
    for (const id of made) await db.remove('discount_codes', { where: { id: eq(id) } }).catch(() => null);
    await db.update('plans', { where: { id: eq(planA) } }, { discount_codes_enabled: flagBefore }, { returning: 'minimal' } as any).catch(() => null);
    const restored = ((await db.select<any>('plans', { where: { id: eq(planA) }, select: ['discount_codes_enabled'], limit: 1 })) as any[])[0]?.discount_codes_enabled;
    console.log('\ncleanup: ' + made.length + ' code(s) removed; plan flag back to ' + restored);
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
