/**
 * PLAN BILLING PROOF (lib/plan-billing.ts, PRICING.md §9), live, Stripe TEST mode.
 *
 *   npx tsx scripts/verify-plan-billing.ts subscribe   test4 buys Growth through the real
 *                                                       dashboard button and Stripe Checkout
 *                                                       (browser, card 4242); the platform
 *                                                       webhook moves test4 to Growth; forged
 *                                                       subscriptions are refused
 *   npx tsx scripts/verify-plan-billing.ts cancel      test4 cancels; webhook -> Free
 *   npx tsx scripts/verify-plan-billing.ts renewal     store B on a Stripe test clock: renewal
 *                                                       fails (card 0341) -> past_due -> still
 *                                                       Growth, 7-day grace; grace passed ->
 *                                                       billed as Free; card fixed -> Growth;
 *                                                       clock deleted -> Free
 *
 * Every plan change here arrives through the deployed platform webhook
 * (Stripe -> goyunir.com/api/stripe/webhook); this script only reads it back.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const APP = 'https://app.goyunir.com';
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
const phase = process.argv[2] || '';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!['subscribe', 'cancel', 'renewal'].includes(phase)) throw new Error('phase: subscribe | cancel | renewal');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const { platformFeeForCharge, tenantPlan } = await import('../lib/billing');
  const { syncPlanSubscription } = await import('../lib/plan-billing');
  const stripe: any = await resolveStripeClient();
  if (!String(process.env.STRIPE_SECRET_KEY).startsWith('sk_test_')) throw new Error('test mode only');
  const kv: any = createKvClient();
  const db = getDb();
  const tenant = async (id: string) => ((await db.select<any>('tenants', { where: { id: eq(id) }, select: ['plan_id', 'plan_grace_until'], limit: 1 })) as any[])[0];
  const subRow = async (id: string) => ((await db.select<any>('tenant_subscriptions', { where: { tenant_id: eq(id) }, select: ['stripe_customer_id', 'stripe_subscription_id', 'status', 'plan_id', 'cancel_at_period_end'], limit: 1 })) as any[])[0] || null;
  const waitFor = async <T>(what: string, read: () => Promise<T>, ok: (v: T) => boolean, ms = 90_000): Promise<T> => {
    const until = Date.now() + ms; let v = await read();
    while (!ok(v) && Date.now() < until) { await sleep(2000); v = await read(); }
    if (!ok(v)) console.log('  (timed out waiting for ' + what + ': ' + JSON.stringify(v) + ')');
    return v;
  };
  const session = async (email: string) => {
    const id = await readStaffIdentity(email);
    if (!id) throw new Error('no identity for ' + email);
    return (await issueAdminDevice(kv, email, false, deviceMetaFor(id), 900)).token;
  };
  const call = async (path: string, token: string | null, method = 'GET') => {
    const headers: Record<string, string> = { origin: APP };
    if (token) headers.cookie = 'goyunir_admin_device=' + token;
    const res = await fetch(APP + path, { method, headers });
    let body: any = null; try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };
  const aOwner = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;

  if (phase === 'subscribe') {
    const sA = await session(aOwner);
    const sB = await session(B_OWNER);
    console.log('\nBefore');
    const before = await tenant(A);
    check(before.plan_id === 'free' && !before.plan_grace_until, 'test4 starts on Free: ' + JSON.stringify(before));
    const feeFree = await platformFeeForCharge(A, 1900);
    check(feeFree.basis === 'graduated' && feeFree.feeCents > 0, 'a $19 test4 sale on Free carries a platform fee: ' + JSON.stringify(feeFree));
    const stA = await call('/api/merchant/billing', sA);
    check(stA.status === 200 && stA.body?.planId === 'free' && stA.body?.upgrade?.planId === 'growth' && stA.body?.upgrade?.monthlyCents === 9900 && /^Per-sale fee: 2% /.test(stA.body?.feeLine), 'the owner sees Free, its fee, and the offer of Growth at $99: ' + JSON.stringify(stA.body));
    const stB = await call('/api/merchant/billing', sB);
    check(stB.status === 200 && stB.body?.planId === 'free', 'store B sees its own plan: ' + JSON.stringify(stB.body?.planId));
    check((await call('/api/merchant/billing', null)).status === 401, 'no session: 401');

    console.log('\nCheckout (real dashboard button, real Stripe Checkout, card 4242)');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'goyunir_admin_device', value: sA, domain: 'app.goyunir.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      await page.goto(APP + '/app', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Plan & billing' }).click();
      const offer = page.getByRole('button', { name: /Switch to Growth: \$99\.00\/month, no per-sale fee/ });
      check(await offer.isVisible(), 'the Billing tab shows "Switch to Growth: $99.00/month, no per-sale fee"');
      await offer.click();
      await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
      check(true, 'the button opens Stripe Checkout');
      const row = await subRow(A);
      const cust = row ? await stripe.customers.retrieve(row.stripe_customer_id) : null;
      check(!!cust && cust.metadata?.tenant_id === A, 'test4 now has ONE billing customer on the platform account, tagged test4: ' + row?.stripe_customer_id);
      await page.waitForSelector('#cardNumber', { timeout: 30_000 }).catch(async () => {
        const acc = page.locator('[data-testid="card-accordion-item-button"]');
        if (await acc.count()) await acc.click();
        await page.waitForSelector('#cardNumber', { timeout: 20_000 });
      });
      const text = await page.locator('body').innerText();
      check(/\$99\.00/.test(text) && /month/i.test(text) && !/trial/i.test(text), 'Checkout asks for $99.00 a month, no trial');
      await page.fill('#cardNumber', '4242424242424242');
      await page.fill('#cardExpiry', '12 / 34');
      await page.fill('#cardCvc', '123');
      if (await page.locator('#billingName').count()) await page.fill('#billingName', 'Plan Proof');
      if (await page.locator('#billingPostalCode').isVisible().catch(() => false)) await page.fill('#billingPostalCode', '10001');
      await page.locator('button[type="submit"], .SubmitButton').first().click();
      await page.waitForURL(/app\.goyunir\.com\/app/, { timeout: 90_000 });
      check(true, 'paid; Stripe returned the owner to the dashboard');
      const shown = await page.waitForFunction(() => document.body.innerText.includes('Your plan: Growth'), null, { timeout: 60_000 }).then(() => true).catch(() => false);
      check(shown, 'the dashboard shows "Your plan: Growth" after the webhook lands');
      check(await page.getByText('No per-sale fee.').isVisible().catch(() => false), 'and "No per-sale fee."');
    } finally { await browser.close(); }

    console.log('\nAfter (read back)');
    const after = await waitFor('growth', () => tenant(A), (t) => t.plan_id === 'growth');
    check(after.plan_id === 'growth' && !after.plan_grace_until, 'test4 is on Growth, no grace: ' + JSON.stringify(after));
    const row = await subRow(A);
    const sub = row?.stripe_subscription_id ? await stripe.subscriptions.retrieve(row.stripe_subscription_id) : null;
    check(row?.status === 'active' && sub?.status === 'active' && sub?.metadata?.tenant_id === A && sub.items.data[0].price.unit_amount === 9900 && !sub.trial_end, 'the subscription is active, $99/month, no trial, tagged test4: ' + JSON.stringify(row));
    const feeGrowth = await platformFeeForCharge(A, 1900);
    check(feeGrowth.feeCents === 0 && feeGrowth.planId === 'growth' && feeGrowth.basis === 'flat', 'a $19 test4 sale now carries NO platform fee: ' + JSON.stringify(feeGrowth));
    const audit = ((await db.select<any>('audit_logs', { where: { tenant_id: eq(A), action: eq('PLAN_CHANGED') }, select: ['actor', 'detail', 'created_at'], order: { column: 'created_at', ascending: false }, limit: 1 })) as any[])[0];
    check(audit?.detail?.to === 'growth' && audit?.actor === 'stripe', 'the change is in the platform audit log: ' + JSON.stringify(audit?.detail));
    const again = await call('/api/merchant/billing/checkout', sA, 'POST');
    check(again.status === 409, 'a second purchase is refused while on Growth: ' + again.status + ' ' + again.body?.error);
    const portal = await call('/api/merchant/billing/portal', sA, 'POST');
    check(portal.status === 200 && /^https:\/\/billing\.stripe\.com\//.test(portal.body?.url), 'Manage billing opens Stripe\'s portal: ' + portal.status);
    const portalB = await call('/api/merchant/billing/portal', sB, 'POST');
    check(portalB.status === 404, 'store B has no billing account and cannot reach test4\'s: ' + portalB.status);

    console.log('\nForgery');
    // A subscription whose metadata names test4 but whose customer is NOT
    // test4's billing customer (anyone with a Stripe account could make one).
    const forger = await stripe.customers.create({ email: 'forger@goyunir.invalid', payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } });
    const priceId = sub.items.data[0].price.id;
    const forged = await stripe.subscriptions.create({ customer: forger.id, items: [{ price: priceId }], metadata: { tenant_id: B, plan_id: 'growth' } });
    const r = await syncPlanSubscription(forged.id);
    check(!r.applied && /refused/.test(r.note), 'a live subscription naming store B, paid by another customer, is refused: ' + r.note);
    await sleep(15_000); // the real webhook for it has landed by now
    const bAfter = await tenant(B);
    check(bAfter.plan_id === 'free', 'store B is still on Free (webhook refused it too): ' + JSON.stringify(bAfter));
    const forgedA = await stripe.subscriptions.create({ customer: forger.id, items: [{ price: priceId }], metadata: { tenant_id: A, plan_id: 'growth' } });
    await stripe.subscriptions.cancel(forgedA.id);
    const r2 = await syncPlanSubscription(forgedA.id);
    check(!r2.applied, 'a forged, then cancelled, subscription naming test4 cannot knock test4 off Growth: ' + r2.note);
    await sleep(10_000);
    check((await tenant(A)).plan_id === 'growth', 'test4 is still on Growth');
    await stripe.subscriptions.cancel(forged.id);
    await stripe.customers.del(forger.id);
  }

  if (phase === 'cancel') {
    const row = await subRow(A);
    check(row?.status === 'active', 'test4 has an active subscription: ' + row?.stripe_subscription_id);
    await stripe.subscriptions.cancel(row.stripe_subscription_id);
    const t = await waitFor('free', () => tenant(A), (x) => x.plan_id === 'free');
    check(t.plan_id === 'free' && !t.plan_grace_until, 'cancelled: the webhook moved test4 back to Free: ' + JSON.stringify(t));
    check((await subRow(A))?.status === 'canceled', 'the subscription row says canceled');
    const fee = await platformFeeForCharge(A, 1900);
    check(fee.basis === 'graduated' && fee.feeCents > 0, 'a $19 test4 sale carries the graduated fee again: ' + JSON.stringify(fee));
    const st = await call('/api/merchant/billing', await session(aOwner));
    check(st.body?.planId === 'free' && st.body?.upgrade?.planId === 'growth', 'the dashboard offers Growth again');
  }

  if (phase === 'renewal') {
    // Store B's billing customer lives on a Stripe test clock so a month can
    // pass in seconds. Same shape billingCustomer() creates, same subscription
    // shape Checkout creates.
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: 'plan-billing-proof' });
    try {
      const customer = await stripe.customers.create({ email: B_OWNER, test_clock: clock.id, metadata: { tenant_id: B }, payment_method: 'pm_card_visa', invoice_settings: { default_payment_method: 'pm_card_visa' } });
      const existing = await subRow(B);
      if (existing) await db.update('tenant_subscriptions', { where: { tenant_id: eq(B) } }, { stripe_customer_id: customer.id, stripe_subscription_id: null, status: null }, { returning: 'minimal' } as any);
      else await db.insert('tenant_subscriptions', { tenant_id: B, stripe_customer_id: customer.id }, { returning: 'minimal' } as any);
      const price = (await stripe.prices.list({ lookup_keys: ['plan_growth_9900_monthly'], active: true, limit: 1 })).data[0];
      const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }], metadata: { tenant_id: B, plan_id: 'growth' } });
      let t = await waitFor('growth', () => tenant(B), (x) => x.plan_id === 'growth');
      check(t.plan_id === 'growth' && !t.plan_grace_until, 'store B pays: Growth: ' + JSON.stringify(t));

      console.log('\nRenewal fails');
      const bad = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: bad.id } });
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: clock.frozen_time + 32 * 86400 });
      await waitFor('clock ready', () => stripe.testHelpers.testClocks.retrieve(clock.id), (c: any) => c.status === 'ready', 120_000);
      const t0 = Date.now();
      t = await waitFor('grace', () => tenant(B), (x) => !!x.plan_grace_until);
      const s2 = await stripe.subscriptions.retrieve(sub.id);
      check(s2.status === 'past_due', 'Stripe: the renewal failed, subscription past_due');
      const graceMs = Date.parse(t.plan_grace_until) - t0;
      check(t.plan_id === 'growth' && graceMs > 6.9 * 86_400_000 && graceMs < 7.01 * 86_400_000, 'store B keeps Growth with a 7-day grace: ' + JSON.stringify(t));
      check((await tenantPlan(B)).id === 'growth' && (await platformFeeForCharge(B, 1900)).feeCents === 0, 'during grace a sale still has no platform fee');
      const stB = await call('/api/merchant/billing', await session(B_OWNER));
      check(stB.body?.status === 'past_due' && stB.body?.graceUntil === t.plan_grace_until, 'the owner\'s Billing tab shows the failed payment and the grace date');

      console.log('\nGrace runs out');
      const graceSaved = t.plan_grace_until;
      await db.update('tenants', { where: { id: eq(B) } }, { plan_grace_until: new Date(Date.now() - 60_000).toISOString() }, { returning: 'minimal' } as any);
      const planAfter = await tenantPlan(B);
      const feeAfter = await platformFeeForCharge(B, 1900);
      check(planAfter.id === 'free' && feeAfter.basis === 'graduated' && feeAfter.feeCents > 0, 'grace passed: billed as Free, graduated fee on the next sale: ' + JSON.stringify(feeAfter));
      check((await call('/api/merchant/billing', await session(B_OWNER))).body?.planId === 'free', 'and the Billing tab says Free');
      await db.update('tenants', { where: { id: eq(B) } }, { plan_grace_until: graceSaved }, { returning: 'minimal' } as any);

      console.log('\nCard fixed');
      const good = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: good.id } });
      const open = (await stripe.invoices.list({ subscription: sub.id, status: 'open', limit: 1 })).data[0];
      await stripe.invoices.pay(open.id, { payment_method: good.id });
      t = await waitFor('grace cleared', () => tenant(B), (x) => !x.plan_grace_until);
      check(t.plan_id === 'growth' && !t.plan_grace_until, 'the invoice is paid: Growth, grace cleared: ' + JSON.stringify(t));
    } finally {
      await stripe.testHelpers.testClocks.del(clock.id);
    }
    const t = await waitFor('free', () => tenant(B), (x) => x.plan_id === 'free');
    check(t.plan_id === 'free', 'test clock deleted (its subscription ends): store B back on Free: ' + JSON.stringify(t));
  }

  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
