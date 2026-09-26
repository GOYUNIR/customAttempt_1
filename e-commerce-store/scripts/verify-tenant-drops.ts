/**
 * MERCHANT RAFFLE + WAITLIST, END TO END (TENANCY.md phase 4).
 *
 *   npx tsx scripts/verify-tenant-drops.ts enter   (then)   npx tsx scripts/verify-tenant-drops.ts draw
 *
 * ENTER — real shoppers on test4.goyunir.com (Chrome, phone width) save cards
 *   on Stripe's hosted card-save page, on the MERCHANT's account:
 *     Connect Test Raffle: three entries, two with 4242…, one with 4000…0341
 *       (the card saves, but a later charge declines);
 *     Connect Test Preorder (not on sale): two waitlist entries.
 *   Read back: each entry pending, recorded with test4's account and its type,
 *   a pm_… card reference, a customer; the confirm step's message shown.
 * DRAW — makes the raffle due and puts the preorder on sale
 *   (seed-tenant-drop-products.ts), fires TWO triggers at once, then reads back:
 *     exactly one draw; the two good raffle cards charged ON test4's account
 *     with our fee, the 0341 card declined and back in the pool; both waitlist
 *     entries charged; an order + one billing row per charge with the fee;
 *     stock down by what was charged; nothing for the default store; a third
 *     trigger draws and charges nothing more.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';

import { chromium } from 'playwright-core';
import { CHROME, IPHONE_UA } from './mobile-audit';

const TENANT = '13591c9e-82e4-4c23-8d94-249cef6fa775';
const STORE = process.env.TENANT_STORE_URL || 'https://test4.goyunir.com';
const OUT = join(process.cwd(), 'tenant-checkout-out');
const STATE = join(OUT, 'drops-state.json');
const RAFFLE = { slug: 'connect-test-raffle', productId: 'prod_tenant_test_3', size: 'Standard', priceCents: 3000 };
const PREORDER = { slug: 'connect-test-preorder', productId: 'prod_tenant_test_4', size: 'One Size', priceCents: 1500 };

let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enterOnce(slug: string, size: string, email: string, card: string, shot: string): Promise<string> {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  await ctx.addInitScript('window.__name = function (f) { return f; };');
  const page = await ctx.newPage();
  try {
    await page.goto(STORE + '/' + slug, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: new RegExp('^' + size, 'i') }).first().tap({ timeout: 10_000 }).catch(() => {});
    const emailInput = page.locator('input[type=email]').first();
    await emailInput.tap({ timeout: 10_000 });
    await emailInput.fill(email);
    const addr = page.locator('input[placeholder*=address i], input[autocomplete*=address i]').first();
    await addr.tap();
    await addr.pressSequentially('1600 Pennsylvania Avenue', { delay: 90 });
    await page.locator('[role=option]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[role=option]').first().tap();
    await page.waitForTimeout(1500);
    await page.locator('.goyunir-pdp-cta-bar button').first().tap({ timeout: 10_000 });
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
    await page.waitForTimeout(3000);
    const fillIf = async (sel: string, value: string) => { const l = page.locator(sel).first(); if (await l.isVisible().catch(() => false)) await l.fill(value); };
    await fillIf('#email', email);
    await page.locator('#cardNumber').first().fill(card, { timeout: 20_000 });
    await fillIf('#cardExpiry', '12 / 34');
    await fillIf('#cardCvc', '123');
    await fillIf('#billingName', 'Test Entrant');
    await fillIf('#billingPostalCode', '94103');
    const link = page.getByLabel(/Save my information/i).first();
    if (await link.isChecked().catch(() => false)) await link.uncheck({ force: true }).catch(() => {});
    await page.locator('button[type=submit], .SubmitButton').first().click({ timeout: 10_000 });
    await page.waitForURL(new RegExp(STORE.replace(/[.]/g, '\\.') + '/'), { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(OUT, shot) });
    const text = await page.evaluate(() => document.body.innerText);
    const m = /(Your entry[^\n]*locked in[^\n]*|You're on the waitlist[^\n]*|You're already[^\n]*|could not verify[^\n]*)/i.exec(text);
    return m ? m[1].trim() : '(no confirmation message visible) ' + page.url();
  } finally {
    await browser.close();
  }
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const stage = process.argv[2];
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { resolveVariantId } = await import('../lib/inventory');
  const { chargeRouteForTenant } = await import('../lib/connect');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const { DEFAULT_TENANT_ID } = await import('../lib/tenant-context');
  const stripe: any = await resolveStripeClient();
  const route = await chargeRouteForTenant(TENANT);
  if (route.route !== 'connected') throw new Error('test4 not connected');
  const acct = route.stripeAccount;
  const raffleVariant = await resolveVariantId(TENANT, RAFFLE.productId, RAFFLE.size);
  const preVariant = await resolveVariantId(TENANT, PREORDER.productId, PREORDER.size);
  const stockOf = async (v: string | null) => v ? Number(((await getDb().select('inventory_levels', { where: { tenant_id: eq(TENANT), variant_id: eq(v) }, select: ['quantity_available'], limit: 1 })) as any[])[0]?.quantity_available) : null;
  const entriesFor = async (emails: string[]) => (await getDb().select('raffle_entries', { where: { tenant_id: eq(TENANT) }, select: ['*'] }) as any[]).filter((e) => emails.includes(String(e.email)));

  if (stage === 'enter') {
    execSync('npx tsx scripts/seed-tenant-drop-products.ts --draw-in=30', { stdio: 'inherit' });
    const run = Date.now().toString(36);
    const raffleEntrants = [
      { email: `raffle-a-${run}@goyunir.invalid`, card: '4242424242424242' },
      { email: `raffle-b-${run}@goyunir.invalid`, card: '4242424242424242' },
      { email: `raffle-decline-${run}@goyunir.invalid`, card: '4000000000000341' },
    ];
    const waitlisters = [
      { email: `wait-a-${run}@goyunir.invalid`, card: '4242424242424242' },
      { email: `wait-b-${run}@goyunir.invalid`, card: '4242424242424242' },
    ];
    console.log('\nEntering (' + run + ')');
    for (const [i, e] of raffleEntrants.entries()) console.log('  raffle ' + e.email + ': "' + await enterOnce(RAFFLE.slug, RAFFLE.size, e.email, e.card, `drops-raffle-${i}.png`) + '"');
    for (const [i, e] of waitlisters.entries()) console.log('  waitlist ' + e.email + ': "' + await enterOnce(PREORDER.slug, PREORDER.size, e.email, e.card, `drops-wait-${i}.png`) + '"');
    await sleep(5000);
    const all = await entriesFor([...raffleEntrants, ...waitlisters].map((e) => e.email));
    console.log('\nRecorded entries');
    for (const e of all) console.log('  ' + e.email + ' ' + e.entry_type + ' ' + e.status + ' ' + e.stripe_account + ' ' + String(e.payment_method_ref).slice(0, 12) + '… customer ' + (e.customer_id ? 'yes' : 'NO'));
    const raffleRows = all.filter((e) => e.variant_id === raffleVariant);
    const waitRows = all.filter((e) => e.variant_id === preVariant);
    check(raffleRows.length === 3 && raffleRows.every((e) => e.status === 'pending' && e.entry_type === 'raffle' && e.stripe_account === acct && /^pm_/.test(String(e.payment_method_ref)) && e.customer_id),
      'three raffle entries pending, on ' + acct + ', each with a saved card and a customer');
    check(waitRows.length === 2 && waitRows.every((e) => e.status === 'pending' && e.entry_type === 'waitlist' && e.stripe_account === acct && /^pm_/.test(String(e.payment_method_ref))),
      'two waitlist entries pending, on ' + acct);
    const onPlatform = await Promise.all(all.map((e) => stripe.paymentMethods.retrieve(String(e.payment_method_ref)).then(() => true).catch(() => false)));
    check(onPlatform.every((x) => !x), 'no saved card exists on the platform account');
    writeFileSync(STATE, JSON.stringify({ run, raffleEntrants, waitlisters, raffleStock: await stockOf(raffleVariant), preStock: await stockOf(preVariant) }, null, 2));
  } else if (stage === 'draw') {
    const st = JSON.parse(readFileSync(STATE, 'utf8'));
    const emails = [...st.raffleEntrants, ...st.waitlisters].map((e: any) => e.email);
    execSync('npx tsx scripts/seed-tenant-drop-products.ts --draw-in=-1 --preorder-live', { stdio: 'inherit' });
    // Let the storefront's own caches expire, as a real trigger would see it.
    await sleep(15000);
    const drawsBefore = ((await getDb().select('drop_draws', { where: { tenant_id: eq(TENANT), variant_id: eq(String(raffleVariant)) } })) as any[]).length;
    console.log('\nTwo triggers at once');
    const fire = () => fetch(STORE + '/api/checkout/auto-draw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    const [r1, r2] = await Promise.all([fire(), fire()]);
    console.log('  trigger 1: ' + JSON.stringify(r1) + '\n  trigger 2: ' + JSON.stringify(r2));
    await sleep(4000);
    const drawsAfter = ((await getDb().select('drop_draws', { where: { tenant_id: eq(TENANT), variant_id: eq(String(raffleVariant)) } })) as any[]).length;
    check(drawsAfter === drawsBefore + 1, 'exactly one draw ran (' + drawsBefore + ' -> ' + drawsAfter + ')');
    const all = await entriesFor(emails);
    const byEmail = (em: string) => all.find((e) => e.email === em);
    for (const e of all) console.log('  ' + e.email + ' ' + e.entry_type + ' -> ' + e.status);
    const good = st.raffleEntrants.slice(0, 2).map((e: any) => byEmail(e.email));
    const bad = byEmail(st.raffleEntrants[2].email);
    check(good.every((e: any) => e?.status === 'charged'), 'both good raffle cards charged');
    check(bad?.status === 'pending', 'the 0341 card declined and went back to the pool (pending)');
    check(st.waitlisters.every((w: any) => byEmail(w.email)?.status === 'charged'), 'both waitlist entries charged');

    console.log('\nStripe + database, per charge');
    const charged = all.filter((e) => e.status === 'charged');
    for (const e of charged) {
      const price = e.variant_id === raffleVariant ? RAFFLE.priceCents : PREORDER.priceCents;
      const pis = await stripe.paymentIntents.search({ query: `metadata['entry_id']:'${e.id}'` }, { stripeAccount: acct });
      const pi = pis.data[0];
      const order = pi ? ((await getDb().select('orders', { where: { tenant_id: eq(TENANT), stripe_payment_intent_id: eq(pi.id) }, select: ['order_ref', 'total_cents', 'platform_fee_cents', 'checkout_mode'] })) as any[]) : [];
      const billing = pi ? ((await getDb().select('tenant_billing_charges', { where: { payment_intent_id: eq(pi.id) } })) as any[]) : [];
      const onPlat = pi ? await stripe.paymentIntents.retrieve(pi.id).then(() => true).catch(() => false) : true;
      check(Boolean(pi) && pi.status === 'succeeded' && pi.amount === price && (pi.application_fee_amount || 0) > 0 && !onPlat
        && order.length === 1 && order[0].total_cents === price && order[0].platform_fee_cents === pi.application_fee_amount
        && billing.length === 1 && billing[0].fee_cents === pi.application_fee_amount,
        e.entry_type + ' ' + e.email + ': ' + (pi ? pi.id + ' ' + pi.amount + ' fee ' + pi.application_fee_amount : 'no PI') + ', order ' + JSON.stringify(order[0] || null) + ', billing rows ' + billing.length);
    }
    const raffleStock = await stockOf(raffleVariant);
    const preStock = await stockOf(preVariant);
    check(raffleStock === st.raffleStock - 2 && preStock === st.preStock - 2, 'stock raffle ' + st.raffleStock + ' -> ' + raffleStock + ', preorder ' + st.preStock + ' -> ' + preStock);
    const defaultOrders = (await getDb().select('orders', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['stripe_payment_intent_id'] }) as any[]);
    const ours = await Promise.all(charged.map(async (e) => (await stripe.paymentIntents.search({ query: `metadata['entry_id']:'${e.id}'` }, { stripeAccount: acct })).data[0]?.id));
    check(!defaultOrders.some((o) => ours.includes(o.stripe_payment_intent_id)), 'nothing written for the default store');

    console.log('\nA third trigger (nothing left to do)');
    const r3 = await fire();
    console.log('  ' + JSON.stringify(r3));
    await sleep(3000);
    const after3 = await entriesFor(emails);
    const drawsAfter3 = ((await getDb().select('drop_draws', { where: { tenant_id: eq(TENANT), variant_id: eq(String(raffleVariant)) } })) as any[]).length;
    check(drawsAfter3 === drawsAfter && after3.filter((e) => e.status === 'charged').length === charged.length, 'no new draw and no new charge');
  } else {
    console.log('usage: verify-tenant-drops.ts enter | draw');
    process.exit(2);
  }
  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.raw?.message || e?.message || e); process.exit(1); });
