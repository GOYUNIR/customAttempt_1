/**
 * STOCK STEP 5 PROOF: the ORIGINAL store's checkout paths hold stock (00037),
 * on production (shop.<root>, the platform Stripe account in test mode), on a
 * HIDDEN fixture product so no real product's stock moves.
 *
 *   npx tsx scripts/verify-stock-original.ts
 *
 *   1. last unit: buyer 1 holds it; buyer 2 refused; buyer 1's next attempt
 *      replaces their own hold (still one).
 *   2. expiry: buyer 1's sessions expired at Stripe -> the platform webhook
 *      releases the hold.
 *   3. recount during an open checkout, then a real test-card payment: on hand
 *      5 -> 4, hold converted, ONE sale movement for the PaymentIntent.
 *   4. cart all or nothing.
 *   5. direct (in-page) charge: success sells once; a declined card releases.
 *   6. every real product's stock row is byte-identical before and after.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';
import { chromium } from 'playwright-core';
import { CHROME, IPHONE_UA } from './mobile-audit';
import { testInbox } from './resend-readback';

const STORE = 'https://shop.goyunir.com';
const FIX = { id: 'prod_stock_orig_fixture', slug: 'stock-orig-fixture' };
const ADDRESS = '1600 Pennsylvania Avenue NW, Washington, DC 20500, United States';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq, neq } = await import('../lib/db/query');
  const { resolveVariantId } = await import('../lib/inventory');
  const { writeProductToPostgres } = await import('../lib/catalog-write');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const stock = await import('../lib/stock');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const stripe: any = await resolveStripeClient();
  const db = getDb();
  const T = await ensureDefaultTenant();
  const run = Date.now().toString(36);

  let vOne = await resolveVariantId(T, FIX.id, 'One');
  if (!vOne) {
    const w = await writeProductToPostgres(T, {
      id: FIX.id, name: 'Stock proof fixture (hidden)', slug: FIX.slug, tagline: '', desc: '',
      isActive: false, isArchived: false, isUpcoming: false, checkoutMode: 'FCFS', productType: 'fcfs', isRaffle: false,
      maxPerEmail: 5, maxPerCart: 5, releaseEndsAt: '', totalInventory: 0, inventoryPerSize: { One: 0, Two: 0 },
      priceCategories: [{ size: 'One', price: 1, checkoutMode: 'FCFS', stripeId: 'price_fixture_unused' }, { size: 'Two', price: 1, checkoutMode: 'FCFS', stripeId: 'price_fixture_unused' }],
      notes: [], images: [], categories: [],
    } as any);
    if (!w.ok) throw new Error('fixture: ' + w.error);
    vOne = await resolveVariantId(T, FIX.id, 'One');
  }
  const v1 = String(vOne);
  const v2 = String(await resolveVariantId(T, FIX.id, 'Two'));
  const others = async () => JSON.stringify(await db.select<any>('inventory_levels', { where: { tenant_id: eq(T), variant_id: neq(v1) }, select: ['variant_id', 'quantity_available'], order: { column: 'variant_id', ascending: true } }).then((r: any[]) => r.filter((x) => x.variant_id !== v2)));
  const realBefore = await others();
  const level = async (v: string) => (await stock.stockLevels(T, [v])).get(v)!;
  const holdsOf = async (email: string) => (await db.select<any>('stock_holds', { where: { tenant_id: eq(T), reference: eq('buyer:' + email) }, select: ['hold_key', 'status', 'variant_id'] })) as any[];
  const waitFor = async (fn: () => Promise<boolean>, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(2000); } return false; };
  const b = { b1: testInbox('so1' + run), b2: testInbox('so2' + run), b3: testInbox('so3' + run), bc: testInbox('soc' + run), bd: testInbox('sod' + run), bx: testInbox('sox' + run) };
  const checkout = (email: string, size = 'One') => fetch(STORE + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE }, body: JSON.stringify({ productId: FIX.id, size, email, address: ADDRESS }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
  const sessions: string[] = [];

  try {
    console.log('\nSetup: fixture One = 1');
    await stock.setStock(T, v1, 1, 'verify-stock-original', run);

    console.log('\n1. The last unit (original store)');
    const c1 = await checkout(b.b1);
    if (c1.body?.sessionId) sessions.push(c1.body.sessionId);
    const s1 = c1.body?.sessionId ? await stripe.checkout.sessions.retrieve(c1.body.sessionId) : null;
    const h1 = await holdsOf(b.b1);
    check(c1.status === 200 && h1.length === 1 && h1[0].status === 'active' && (await level(v1)).available === 0, 'buyer 1 holds the unit: ' + c1.status + ' ' + (c1.body?.error || c1.body?.sessionId || ''));
    const life = s1 ? s1.expires_at - Math.floor(Date.now() / 1000) : 0;
    check(Boolean(s1) && s1.metadata?.hold_key === h1[0]?.hold_key && life > 1700 && life <= 1900, 'the platform Stripe session carries the hold and closes in ~31 min (' + Math.round(life / 60) + ' min)');
    const c2 = await checkout(b.b2);
    check(c2.status === 409 && (await holdsOf(b.b2)).length === 0, 'buyer 2 is refused: ' + c2.status + ' "' + c2.body?.error + '"');
    const c1b = await checkout(b.b1);
    if (c1b.body?.sessionId) sessions.push(c1b.body.sessionId);
    const act = (await holdsOf(b.b1)).filter((h) => h.status === 'active');
    check(c1b.status === 200 && act.length === 1 && act[0].hold_key !== h1[0]?.hold_key && (await level(v1)).held === 1, 'buyer 1\'s next attempt replaces their own hold (still one held)');

    console.log('\n2. Expiry releases (platform webhook)');
    for (const s of sessions.splice(0)) await stripe.checkout.sessions.expire(s).catch((e: any) => console.log('   expire: ' + e?.message));
    check(await waitFor(async () => (await holdsOf(b.b1)).every((h) => h.status === 'released')) && (await level(v1)).available === 1, 'checkout.session.expired released buyer 1\'s hold: available 1');

    console.log('\n3. Recount during an open checkout, then the payment');
    const c3 = await checkout(b.b3);
    check(c3.status === 200 && (await level(v1)).available === 0, 'buyer 3 holds the unit');
    await stock.setStock(T, v1, 5, 'verify-stock-original', run + ' recount');
    const l3 = await level(v1);
    check(l3.onHand === 5 && l3.held === 1 && l3.available === 4, 'counted 5: 4 for sale, the hold survives (' + JSON.stringify(l3) + ')');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE_UA })).newPage();
      await page.goto(c3.body.url, { waitUntil: 'load', timeout: 60_000 }); await page.waitForTimeout(3000);
      const fillIf = async (sel: string, value: string) => { const l = page.locator(sel).first(); if (await l.isVisible().catch(() => false)) await l.fill(value); };
      await fillIf('#email', b.b3);
      await page.locator('#cardNumber').first().fill('4242424242424242', { timeout: 20_000 });
      await fillIf('#cardExpiry', '12 / 34'); await fillIf('#cardCvc', '123'); await fillIf('#billingName', 'Test Buyer'); await fillIf('#billingPostalCode', '94103');
      const link = page.getByLabel(/Save my information/i).first();
      if (await link.isChecked().catch(() => false)) await link.uncheck({ force: true }).catch(() => {});
      await page.locator('button[type=submit], .SubmitButton').first().click({ timeout: 10_000 });
      await page.waitForURL(/shop\.goyunir\.com\/.*purchase=success/, { timeout: 60_000 }).catch(() => {});
    } finally { await browser.close(); }
    const paid = await stripe.checkout.sessions.retrieve(c3.body.sessionId);
    const pi = String(paid.payment_intent);
    check(paid.payment_status === 'paid', 'buyer 3 paid');
    const conv = await waitFor(async () => (await holdsOf(b.b3))[0]?.status === 'converted');
    const sales = (await db.select<any>('stock_movements', { where: { tenant_id: eq(T), variant_id: eq(v1), reason: eq('sale'), reference: eq(pi) }, select: ['delta', 'quantity_after', 'shortfall'] })) as any[];
    const l4 = await level(v1);
    check(conv && l4.onHand === 4 && l4.held === 0 && sales.length === 1 && sales[0].delta === -1 && sales[0].shortfall === 0, 'the webhook sold the held unit: 5 -> 4, one sale for ' + pi + ' (' + JSON.stringify(sales) + ')');

    console.log('\n4. Cart (original store)');
    await stock.setStock(T, v2, 1, 'verify-stock-original', run);
    const cart = (items: any[]) => fetch(STORE + '/api/checkout/cart', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE }, body: JSON.stringify({ email: b.bc, address: ADDRESS, items }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
    const tooMany = await cart([{ productId: FIX.id, size: 'One', quantity: 1 }, { productId: FIX.id, size: 'Two', quantity: 2 }]);
    check(tooMany.status === 409 && (await holdsOf(b.bc)).length === 0 && (await level(v1)).available === 4, 'One x1 + Two x2 (1 left): refused (' + tooMany.status + ' "' + tooMany.body?.error + '"), nothing held');
    const fits = await cart([{ productId: FIX.id, size: 'One', quantity: 1 }, { productId: FIX.id, size: 'Two', quantity: 1 }]);
    const ch = (await holdsOf(b.bc)).filter((h) => h.status === 'active');
    check(fits.status === 200 && ch.length === 2 && (await level(v2)).available === 0, 'One x1 + Two x1: both held under one checkout (' + fits.status + ')');
    const cartSession = fits.body?.fcfsSessionId || fits.body?.sessionId || (String(fits.body?.fcfsUrl || fits.body?.url || '').match(/cs_test_[A-Za-z0-9]+/) || [])[0];
    if (cartSession) await stripe.checkout.sessions.expire(cartSession).catch(() => null);
    check(Boolean(cartSession) && await waitFor(async () => (await holdsOf(b.bc)).every((h) => h.status === 'released')), 'the cart\'s expiry releases both lines');

    console.log('\n5. Direct (in-page) charge');
    await stock.setStock(T, v2, 1, 'verify-stock-original', run);
    const direct = (email: string, pm: string) => fetch(STORE + '/api/checkout/direct', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE }, body: JSON.stringify({ productId: FIX.id, size: 'Two', email, shippingAddress: ADDRESS, paymentMethodId: pm }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
    const declined = await direct(b.bx, 'pm_card_chargeDeclined');
    const lx = await level(v2);
    check(declined.status >= 400 && lx.onHand === 1 && lx.held === 0 && (await holdsOf(b.bx)).every((h) => h.status === 'released'), 'a declined card: refused (' + declined.status + '), the hold released, still 1 on hand');
    const ok = await direct(b.bd, 'pm_card_visa');
    const ld = await level(v2);
    const dsales = (await db.select<any>('stock_movements', { where: { tenant_id: eq(T), variant_id: eq(v2), reason: eq('sale') }, select: ['reference', 'delta'], order: { column: 'id', ascending: false }, limit: 1 })) as any[];
    check(ok.status === 200 && ld.onHand === 0 && ld.held === 0 && /^pi_/.test(String(dsales[0]?.reference)) && (await holdsOf(b.bd)).every((h) => h.status === 'converted'), 'a good card: 200, sold once through the ledger (' + (dsales[0]?.reference || '?') + '), hold converted: ' + JSON.stringify(ok.body).slice(0, 100));

    console.log('\n6. The real products');
    check((await others()) === realBefore, 'every real product\'s stock row is byte-identical');
  } finally {
    for (const s of sessions) await stripe.checkout.sessions.expire(s).catch(() => null);
    for (const e of Object.values(b)) for (const h of await holdsOf(e)) if (h.status === 'active') await stock.releaseStock(T, h.hold_key).catch(() => 0);
    await stock.setStock(T, v1, 0, 'verify-stock-original', run + ' cleanup').catch(() => null);
    await stock.setStock(T, v2, 0, 'verify-stock-original', run + ' cleanup').catch(() => null);
    console.log('\nfixture back to 0, holds released');
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.raw?.message || e?.message || e); process.exit(1); });
