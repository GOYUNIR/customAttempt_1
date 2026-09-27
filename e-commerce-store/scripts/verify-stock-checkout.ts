/**
 * STOCK STEP 3 PROOF: merchant checkout + cart hold stock (00037), on
 * production, through test4.goyunir.com's real checkout API, real Stripe
 * sessions on the merchant's account, and one real test-card payment.
 *
 *   npx tsx scripts/verify-stock-checkout.ts
 *
 *   1. last unit: buyer 1 holds it; the storefront shows it gone; buyer 2 is
 *      refused; a double tap by buyer 1 is not a second hold.
 *   2. expired-hold release: buyer 1's session is expired at Stripe; the
 *      Connect webhook releases the unit; it is for sale again.
 *   3. recount during an open checkout: buyer 3 holds; the merchant counts 5;
 *      4 are for sale and the hold survives; buyer 3 pays: on hand 4, the hold
 *      converted, ONE sale movement for that PaymentIntent, an order.
 *   4. a cart is all or nothing.
 * Stock of the items used is restored at the end.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';
import { chromium } from 'playwright-core';
import { CHROME, IPHONE_UA } from './mobile-audit';
import { testInbox } from './resend-readback';

const A = '13591c9e-82e4-4c23-8d94-249cef6fa775';
const STORE = 'https://test4.goyunir.com';
const APP = 'https://app.goyunir.com';
const ITEM = { id: 'prod_tenant_test_1', size: 'One Size' };
const PAIR_S = { id: 'prod_tenant_test_2', size: 'Small' };
const PAIR_L = { id: 'prod_tenant_test_2', size: 'Large' };
const ADDRESS = '1600 Pennsylvania Avenue NW, Washington, DC 20500, United States';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { resolveVariantId } = await import('../lib/inventory');
  const stock = await import('../lib/stock');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const { chargeRouteForTenant } = await import('../lib/connect');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { ADMIN_DEVICES_KEY } = await import('../lib/redis-keys');
  const stripe: any = await resolveStripeClient();
  const acct = (await chargeRouteForTenant(A) as any).stripeAccount;
  const on = { stripeAccount: acct };
  const db = getDb();
  const run = Date.now().toString(36);
  const v = String(await resolveVariantId(A, ITEM.id, ITEM.size));
  const vS = String(await resolveVariantId(A, PAIR_S.id, PAIR_S.size));
  const vL = String(await resolveVariantId(A, PAIR_L.id, PAIR_L.size));
  const level = async (id: string) => (await stock.stockLevels(A, [id])).get(id)!;
  const original = { [v]: (await level(v)).onHand, [vS]: (await level(vS)).onHand, [vL]: (await level(vL)).onHand };
  const buyers = { b1: testInbox('sc1' + run), b2: testInbox('sc2' + run), b3: testInbox('sc3' + run), bc: testInbox('scc' + run) };
  const checkout = (email: string, item = ITEM) => fetch(STORE + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE }, body: JSON.stringify({ productId: item.id, size: item.size, email, address: ADDRESS }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
  const holdsOf = async (email: string) => (await db.select<any>('stock_holds', { where: { tenant_id: eq(A), reference: eq('buyer:' + email) }, select: ['hold_key', 'status', 'variant_id', 'quantity', 'expires_at'] })) as any[];
  // What the product page itself reads (components/Storefront.tsx: soldOut /
  // totalInventory from /api/store?slug=). Returns the units it shows for sale,
  // 0 when it shows sold out.
  const storefrontLeft = async () => {
    const s: any = await fetch(STORE + '/api/store?slug=connect-test-item&t=' + Date.now(), { headers: { 'cache-control': 'no-cache' } }).then((r) => r.json()).catch(() => null);
    const p = s?.product;
    if (!p) return undefined;
    return p.soldOut === true ? 0 : Number(p.inventoryRemaining ?? p.totalInventory ?? 0);
  };
  const waitFor = async (fn: () => Promise<boolean>, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(2000); } return false; };
  const kv: any = createKvClient();
  const owner = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sOwner = (await issueAdminDevice(kv, owner, false, deviceMetaFor((await readStaffIdentity(owner))!), 900)).token;

  try {
    console.log('\nSetup: ' + ITEM.id + ' set to 1 on hand (a count)');
    await stock.setStock(A, v, 1, 'verify-stock-checkout', run);
    check((await level(v)).available === 1, 'on hand 1, available 1');

    console.log('\n1. The last unit');
    const t1 = Date.now();
    const c1 = await checkout(buyers.b1);
    const s1 = c1.body?.sessionId;
    check(c1.status === 200 && /^cs_test_/.test(String(s1)), 'buyer 1 gets a checkout: ' + c1.status + ' ' + (s1 || JSON.stringify(c1.body)));
    const h1 = await holdsOf(buyers.b1);
    const l1 = await level(v);
    check(h1.length === 1 && h1[0].status === 'active' && l1.onHand === 1 && l1.held === 1 && l1.available === 0, 'the unit is HELD for buyer 1 (on hand 1, held 1, available 0), nothing sold yet');
    const sess1 = s1 ? await stripe.checkout.sessions.retrieve(s1, {}, on) : null;
    const life = sess1 ? sess1.expires_at - Math.floor(t1 / 1000) : 0;
    const holdLife = h1[0] ? (Date.parse(h1[0].expires_at) - t1) / 1000 : 0;
    check(Boolean(sess1) && sess1.metadata?.hold_key === h1[0]?.hold_key && life >= 1800 && life <= 1920 && holdLife > life, 'the Stripe session carries the hold and ends first: session ' + Math.round(life / 60) + ' min, hold ' + Math.round(holdLife / 60) + ' min');
    const again = await checkout(buyers.b1);
    const h1b = (await holdsOf(buyers.b1)).filter((h) => h.status === 'active');
    check(again.status === 200 && h1b.length === 1 && (await level(v)).held === 1, 'a second tap by buyer 1 is not a second hold (' + (again.body?.sessionId === s1 ? 'same session' : 'new window: older hold replaced') + ')');
    const c2 = await checkout(buyers.b2);
    check(c2.status === 409 && /sold out/i.test(String(c2.body?.error)) && (await holdsOf(buyers.b2)).length === 0, 'buyer 2 is refused while buyer 1 holds it: ' + c2.status + ' "' + c2.body?.error + '"');
    check(await waitFor(async () => (await storefrontLeft()) === 0, 45_000), 'the storefront shows it sold out during the hold');

    console.log('\n2. An expired checkout gives the unit back');
    const liveSessions = [...new Set([s1, again.body?.sessionId].filter(Boolean))];
    for (const s of liveSessions) await stripe.checkout.sessions.expire(s, {}, on).catch((e: any) => console.log('   expire ' + s + ': ' + e?.message));
    const released = await waitFor(async () => (await holdsOf(buyers.b1)).every((h) => h.status === 'released'));
    check(released && (await level(v)).available === 1, 'Stripe\'s checkout.session.expired reached the webhook and released the hold: available 1');
    check(await waitFor(async () => (await storefrontLeft()) === 1, 45_000), 'the storefront shows it for sale again');

    console.log('\n3. A recount during an open checkout, then the payment');
    const c3 = await checkout(buyers.b3);
    const s3 = c3.body?.sessionId;
    check(c3.status === 200 && (await level(v)).available === 0, 'buyer 3 holds the unit');
    const count = await fetch(APP + '/api/merchant/stock/set', { method: 'POST', headers: { 'content-type': 'application/json', origin: APP, cookie: 'goyunir_admin_device=' + sOwner }, body: JSON.stringify({ variantId: v, count: 5, note: 'recount during open checkout ' + run }) }).then((r) => r.json());
    const l3 = await level(v);
    check(count?.onHand === 5 && l3.onHand === 5 && l3.held === 1 && l3.available === 4 && (await holdsOf(buyers.b3))[0]?.status === 'active', 'the merchant counts 5: 4 for sale, buyer 3\'s hold survives (' + JSON.stringify(l3) + ')');
    // Pay buyer 3's session with a test card, as a shopper would.
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE_UA })).newPage();
      await page.goto(c3.body.url, { waitUntil: 'load', timeout: 60_000 }); await page.waitForTimeout(3000);
      const fillIf = async (sel: string, value: string) => { const l = page.locator(sel).first(); if (await l.isVisible().catch(() => false)) await l.fill(value); };
      await fillIf('#email', buyers.b3);
      await page.locator('#cardNumber').first().fill('4242424242424242', { timeout: 20_000 });
      await fillIf('#cardExpiry', '12 / 34'); await fillIf('#cardCvc', '123'); await fillIf('#billingName', 'Test Buyer'); await fillIf('#billingPostalCode', '94103');
      const link = page.getByLabel(/Save my information/i).first();
      if (await link.isChecked().catch(() => false)) await link.uncheck({ force: true }).catch(() => {});
      await page.locator('button[type=submit], .SubmitButton').first().click({ timeout: 10_000 });
      await page.waitForURL(/test4\.goyunir\.com\/.*purchase=success/, { timeout: 60_000 }).catch(() => {});
    } finally { await browser.close(); }
    const paid = await stripe.checkout.sessions.retrieve(s3, {}, on);
    check(paid.payment_status === 'paid', 'buyer 3 paid: ' + paid.payment_status);
    const pi = String(paid.payment_intent);
    const converted = await waitFor(async () => (await holdsOf(buyers.b3))[0]?.status === 'converted');
    const sales = (await db.select<any>('stock_movements', { where: { tenant_id: eq(A), variant_id: eq(v), reason: eq('sale'), reference: eq(pi) }, select: ['delta', 'quantity_after', 'shortfall'] })) as any[];
    const l4 = await level(v);
    const order = (await db.select<any>('orders', { where: { tenant_id: eq(A), stripe_payment_intent_id: eq(pi) }, select: ['order_ref', 'total_cents'] })) as any[];
    check(converted && l4.onHand === 4 && l4.held === 0 && l4.available === 4, 'the webhook converted the hold: on hand 5 -> 4, nothing held (' + JSON.stringify(l4) + ')');
    check(sales.length === 1 && sales[0].delta === -1 && sales[0].quantity_after === 4 && sales[0].shortfall === 0 && order.length === 1, 'exactly one sale movement for ' + pi + ' (-1 -> 4, no shortfall) and one order ' + (order[0]?.order_ref || '?'));

    console.log('\n4. A cart is all or nothing');
    await stock.setStock(A, vS, 1, 'verify-stock-checkout', run);
    await stock.setStock(A, vL, 1, 'verify-stock-checkout', run);
    const cart = (items: any[]) => fetch(STORE + '/api/checkout/cart', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE }, body: JSON.stringify({ email: buyers.bc, address: ADDRESS, items }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
    const tooMany = await cart([{ productId: PAIR_S.id, size: PAIR_S.size, quantity: 1 }, { productId: PAIR_L.id, size: PAIR_L.size, quantity: 2 }]);
    check(tooMany.status === 409 && (await holdsOf(buyers.bc)).length === 0 && (await level(vS)).available === 1, 'Small x1 + Large x2 (1 left): refused (' + tooMany.status + ' "' + tooMany.body?.error + '"), and Small is NOT held');
    const fits = await cart([{ productId: PAIR_S.id, size: PAIR_S.size, quantity: 1 }, { productId: PAIR_L.id, size: PAIR_L.size, quantity: 1 }]);
    const ch = await holdsOf(buyers.bc);
    check(fits.status === 200 && ch.length === 2 && ch.every((h) => h.status === 'active' && h.hold_key === ch[0].hold_key) && (await level(vS)).available === 0 && (await level(vL)).available === 0, 'Small x1 + Large x1: both held under one checkout');
    if (fits.body?.sessionId) await stripe.checkout.sessions.expire(fits.body.sessionId, {}, on).catch(() => null);
    check(await waitFor(async () => (await holdsOf(buyers.bc)).every((h) => h.status === 'released')), 'the cart\'s expiry releases both lines');
  } finally {
    for (const [id, qty] of Object.entries(original)) await stock.setStock(A, id, qty, 'verify-stock-checkout', run + ' restore').catch(() => null);
    for (const e of Object.values(buyers)) for (const h of await holdsOf(e)) if (h.status === 'active') await stock.releaseStock(A, h.hold_key).catch(() => 0);
    await kv.hdel(ADMIN_DEVICES_KEY, sOwner);
    console.log('\nstock restored (' + JSON.stringify(original) + '), holds released, session deleted');
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.raw?.message || e?.message || e); process.exit(1); });
