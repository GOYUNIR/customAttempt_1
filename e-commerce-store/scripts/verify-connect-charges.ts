/**
 * CONNECT CHARGE CHECK (CONNECT.md §7 steps 3–5, the Stripe side).
 *
 *   npx tsx scripts/verify-connect-charges.ts [tenantId]      (default: test4)
 *
 * Real TEST-MODE money on the tenant's connected account, read back from
 * Stripe, never asserted:
 *   1. A direct charge on the MERCHANT's account carrying the graduated
 *      platform fee (platformFeeForCharge) as application_fee_amount: the
 *      charge lives on their account; the application fee equals the fee.
 *   2. A refund with refund_application_fee: the fee comes back exactly (D5).
 *   3. The dispute test card (pm_card_createDispute = 4000 0000 0000 0259):
 *      the dispute is on the merchant's account and debits THEIR balance;
 *      nothing on the platform's balance moves for it.
 *
 * It does not touch orders or tenant_billing_charges: the storefront's
 * checkout routes are single-tenant today (every sale resolves to the
 * default tenant), so no route can sell for this tenant yet. This proves the
 * Stripe mechanics the routes will use.
 *
 * Stops cleanly (exit 2) if the tenant is not yet enabled for charges.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const p = join(process.cwd(), '.env.local');
if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }

const TENANT = process.argv[2] || '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const AMOUNT = 1900; // test amount, minor units
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { chargeRouteForTenant, syncConnectedAccount } = await import('../lib/connect');
  const { platformFeeForCharge } = await import('../lib/billing');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const stripe: any = await resolveStripeClient();

  let route = await chargeRouteForTenant(TENANT);
  if (route.route !== 'connected') {
    // The tenant row is a cache; ask Stripe before giving up.
    const { getDb } = await import('../lib/db/client');
    const { eq } = await import('../lib/db/query');
    const row = ((await getDb().select<any>('tenants', { where: { id: eq(TENANT) }, select: ['stripe_account_id'], limit: 1 })) as any[])[0];
    if (row?.stripe_account_id) await syncConnectedAccount(String(row.stripe_account_id));
    route = await chargeRouteForTenant(TENANT);
  }
  if (route.route !== 'connected') {
    console.log('NOT READY: route ' + JSON.stringify(route) + ' — finish onboarding first (scripts/connect-onboarding-link.ts).');
    process.exit(2);
  }
  const acct = route.stripeAccount;
  const on = { stripeAccount: acct };
  const v2 = await stripe.v2.core.accounts.retrieve(acct);
  const currency = String(v2.defaults?.currency || '');
  if (!currency) throw new Error('connected account has no default currency');
  const runId = Date.now().toString(36);
  const startedAt = Math.floor(Date.now() / 1000) - 5;
  console.log('tenant ' + TENANT + ' -> ' + acct + ' (' + currency + '), run ' + runId);

  const fee = await platformFeeForCharge(TENANT, AMOUNT);
  console.log('platform fee for ' + AMOUNT + ': ' + JSON.stringify(fee));
  const feeParam = fee.feeCents > 0 ? { application_fee_amount: fee.feeCents } : {};

  // ── 1. a direct charge on the merchant's account, with the fee ─────────────
  console.log('\n1. direct charge with application fee');
  const pi = await stripe.paymentIntents.create({
    amount: AMOUNT, currency, payment_method: 'pm_card_visa', payment_method_types: ['card'], confirm: true,
    description: 'Connect verification ' + runId, metadata: { tenant_id: TENANT, verify_run: runId }, ...feeParam,
  }, { ...on, idempotencyKey: 'verify-connect:' + acct + ':' + runId + ':charge' });
  check(pi.status === 'succeeded', 'PaymentIntent ' + pi.id + ' succeeded on ' + acct + ' (status ' + pi.status + ')');
  const onPlatform = await stripe.paymentIntents.retrieve(pi.id).then(() => true).catch(() => false);
  check(!onPlatform, 'the PaymentIntent does NOT exist on the platform account');
  const charge = await stripe.charges.retrieve(String(pi.latest_charge), {}, on);
  check((charge.application_fee_amount || 0) === fee.feeCents, 'charge.application_fee_amount = ' + charge.application_fee_amount + ' (expected ' + fee.feeCents + ')');
  let appFee: any = null;
  if (fee.feeCents > 0) {
    appFee = (await stripe.applicationFees.list({ charge: charge.id, limit: 1 })).data[0];
    check(Boolean(appFee) && appFee.amount === fee.feeCents && appFee.account === acct,
      'platform received application fee ' + (appFee ? appFee.id + ' ' + appFee.amount + ' from ' + appFee.account : '(none)'));
  }

  // ── 2. refund, returning the fee exactly ───────────────────────────────────
  console.log('\n2. refund with refund_application_fee');
  const refund = await stripe.refunds.create({ payment_intent: pi.id, refund_application_fee: true },
    { ...on, idempotencyKey: 'verify-connect:' + acct + ':' + runId + ':refund' });
  check(refund.status === 'succeeded' || refund.status === 'pending', 'refund ' + refund.id + ' ' + refund.status + ' for ' + refund.amount);
  if (appFee) {
    let fr: any = null;
    for (let i = 0; i < 10 && !(fr && fr.amount_refunded === fee.feeCents); i++) { fr = await stripe.applicationFees.retrieve(appFee.id); if (fr.amount_refunded !== fee.feeCents) await sleep(1500); }
    check(fr.amount_refunded === fee.feeCents && fr.refunded === true, 'application fee refunded exactly: ' + fr.amount_refunded + ' of ' + fee.feeCents);
  }

  // ── 3. the dispute test card: whose balance pays ───────────────────────────
  console.log('\n3. dispute test card (4000 0000 0000 0259)');
  const acctBefore = await stripe.balance.retrieve(on);
  const dpi = await stripe.paymentIntents.create({
    amount: AMOUNT, currency, payment_method: 'pm_card_createDispute', payment_method_types: ['card'], confirm: true,
    description: 'Connect dispute verification ' + runId, metadata: { tenant_id: TENANT, verify_run: runId }, ...feeParam,
  }, { ...on, idempotencyKey: 'verify-connect:' + acct + ':' + runId + ':dispute' });
  check(dpi.status === 'succeeded', 'disputed-card PaymentIntent ' + dpi.id + ' succeeded');
  let dispute: any = null;
  for (let i = 0; i < 30 && !dispute; i++) {
    dispute = (await stripe.disputes.list({ payment_intent: dpi.id, limit: 1 }, on)).data[0] || null;
    if (!dispute) await sleep(2000);
  }
  check(Boolean(dispute), 'dispute ' + (dispute ? dispute.id + ' (' + dispute.status + ', ' + dispute.amount + ')' : 'never appeared') + ' is on the MERCHANT account');
  if (dispute) {
    const bts = dispute.balance_transactions || [];
    const debit = bts.reduce((s: number, b: any) => s + (b.net || 0), 0);
    check(bts.length > 0 && debit < 0, 'the dispute debited the merchant balance: ' + bts.map((b: any) => b.id + ' net ' + b.net + ' ' + b.currency).join(', '));
    const platformHasIt = await stripe.disputes.retrieve(dispute.id).then(() => true).catch(() => false);
    check(!platformHasIt, 'the dispute does NOT exist on the platform account');
    const platTx = await stripe.balanceTransactions.list({ created: { gte: startedAt }, limit: 100 });
    const platDisputeTx = platTx.data.filter((t: any) => /dispute|adjustment/.test(String(t.type)) || String(t.source || '') === dispute.id);
    check(platDisputeTx.length === 0, 'no dispute/adjustment on the platform balance since this run started (' + platDisputeTx.map((t: any) => t.id + ' ' + t.type + ' ' + t.net).join(', ') + ')');
    const acctAfter = await stripe.balance.retrieve(on);
    const sum = (b: any) => [...(b.available || []), ...(b.pending || [])].filter((x: any) => x.currency === currency).reduce((s: number, x: any) => s + x.amount, 0);
    console.log('  merchant balance (' + currency + ', available+pending): ' + sum(acctBefore) + ' -> ' + sum(acctAfter));
    if (appFee || fee.feeCents > 0) {
      const dfee = (await stripe.applicationFees.list({ charge: String(dpi.latest_charge), limit: 1 })).data[0];
      console.log('  platform fee on the disputed charge: ' + (dfee ? dfee.amount + ', refunded ' + dfee.amount_refunded : 'none') + ' (Stripe does not return it automatically on a dispute)');
    }
  }

  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.raw?.message || e.message || e); process.exit(1); });
