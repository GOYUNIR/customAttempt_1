/**
 * PLANS & BILLING VERIFICATION (00032).
 *
 *   npm run verify:billing
 *
 * Run against the real database after 00032 is applied. Checks the properties
 * the money path depends on, not merely that the rows exist:
 *   - the seeded plans are the published plans, and the envelope built from
 *     the DATABASE equals the one built from the published data — with Scale
 *     (stored at $0) kept OUT of it
 *   - every tenant is on a plan
 *   - a charge is recorded once per PaymentIntent, including under
 *     concurrency, and the month total moves exactly once
 *   - refunds set, never add, and an unknown charge is reported, not ignored
 *   - the billing functions cannot be called with the public anon key
 * Writes only tenant_billing_charges rows with a 'pi_verify_' id, removed at
 * the end.
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

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const STAMP = Date.now().toString(36);

async function main() {
  const billing = await import('../lib/billing');
  const { graduatedSchedule, monthlyFeeCents } = await import('../lib/pricing/graduated-fee');
  const { PLANS: PUBLISHED } = await import('../lib/platform-marketing');
  const { getDb } = await import('../lib/db/client');
  const { like } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const db = getDb();
  const tenantId = await ensureDefaultTenant();

  console.log('\nPlans & billing — the contract, and a ledger that counts each sale once');
  console.log('='.repeat(74));

  console.log('1. Plans are the published plans');
  const plans = await billing.loadPlans();
  check(plans.map((p) => p.id).join(',') === 'free,starter,growth,scale', 'four plans, in order', plans.map((p) => p.id).join(','));
  for (const pub of PUBLISHED as any[]) {
    const row = plans.find((p) => p.id === pub.id);
    if (pub.monthlyUsd !== null) check(row?.baseCents === Math.round(pub.monthlyUsd * 100), pub.id + ' price matches the published price', JSON.stringify(row));
    if (typeof pub.platformFeeBps === 'number') check(row?.platformFeeBps === pub.platformFeeBps, pub.id + ' fee matches the published fee', JSON.stringify(row));
  }
  check(plans.find((p) => p.id === 'starter')?.listed === false, 'D2: Starter is not sold');
  check(plans.filter((p) => p.listed).map((p) => p.id).join(',') === 'free,growth,scale', 'sold plans are Free, Growth, Scale');
  check(plans.find((p) => p.id === 'free')?.feeMode === 'graduated', 'Free pays the graduated fee');

  console.log('\n2. The envelope comes from the database, and Scale is not in it');
  const envelope = billing.envelopeOf(plans);
  check(!envelope.some((p) => p.id === 'scale'), 'Scale (stored at $0) is excluded', JSON.stringify(envelope));
  const publishedEnvelope = (PUBLISHED as any[])
    .filter((p) => p.monthlyUsd !== null && typeof p.platformFeeBps === 'number')
    .map((p) => ({ id: p.id, monthlyCents: Math.round(p.monthlyUsd * 100), feeBps: p.platformFeeBps }));
  check(JSON.stringify(graduatedSchedule(envelope)) === JSON.stringify(graduatedSchedule(publishedEnvelope)),
    'database schedule = published schedule', JSON.stringify(graduatedSchedule(envelope)));
  check(monthlyFeeCents(envelope, 5_000_000) === 9900, 'a $50,000 month costs $99 from the database plans');

  console.log('\n3. Every tenant is on a plan');
  const tenants = (await db.select<any>('tenants', { select: ['id', 'plan_id'], limit: 1000 })) as any[];
  check(tenants.length > 0 && tenants.every((t) => t.plan_id), tenants.length + ' tenants, all with a plan', JSON.stringify(tenants.filter((t) => !t.plan_id)));
  const mine = await billing.tenantPlan(tenantId);
  check(mine.id === 'free', 'the default tenant is on Free', mine.id);

  console.log('\n4. One charge, recorded once');
  const month = billing.billingMonthOf();
  check(/^\d{4}-\d{2}-01$/.test(month), 'billing month is the first of the UTC month: ' + month);
  const before = await billing.billingMonthVolume(tenantId, month);
  const pi = 'pi_verify_' + STAMP;
  const first = await billing.recordBillingCharge({ paymentIntentId: pi, tenantId, volumeCents: 12_345, feeCents: 247, month });
  check(first.recorded && first.monthVolumeCents === before + 12_345, 'first delivery records it and the month moves by the sale', JSON.stringify(first));
  const again = await billing.recordBillingCharge({ paymentIntentId: pi, tenantId, volumeCents: 12_345, feeCents: 247, month });
  check(!again.recorded && again.monthVolumeCents === before + 12_345, 'a redelivery records nothing and the month does not move', JSON.stringify(again));

  const racePi = 'pi_verify_race_' + STAMP;
  const race = await Promise.all(Array.from({ length: 10 }, () =>
    billing.recordBillingCharge({ paymentIntentId: racePi, tenantId, volumeCents: 1000, feeCents: 20, month })));
  check(race.filter((r) => r.recorded).length === 1, '10 simultaneous deliveries of one charge -> recorded exactly once',
    JSON.stringify(race.map((r) => r.recorded)));
  check(await billing.billingMonthVolume(tenantId, month) === before + 12_345 + 1000, 'and the month moved by it exactly once');

  console.log('\n5. Refunds set, never add (D5)');
  check(await billing.setBillingRefund(pi, 12_345, 247), 'a full refund applies');
  check(await billing.billingMonthVolume(tenantId, month) === before + 1000, 'the refunded sale leaves the month');
  check(await billing.setBillingRefund(pi, 12_345, 247), 'the same refund event again');
  check(await billing.billingMonthVolume(tenantId, month) === before + 1000, 'changes nothing the second time');
  check(!(await billing.setBillingRefund('pi_verify_never_' + STAMP, 1, 1)), 'a refund for an unrecorded charge is reported (false), not ignored');
  let rejected = false;
  try { await billing.setBillingRefund(pi, 99_999_999, 0); } catch { rejected = true; }
  check(rejected, 'a refund larger than the sale is refused by the database');

  console.log('\n6. Server-only');
  const { url } = (await import('../services/config/supabase-client')).readSupabaseEnv();
  const anon = process.env.SUPABASE_ANON_KEY || '';
  if (!anon) {
    check(false, 'anon key available to test with', 'SUPABASE_ANON_KEY missing from .env.local');
  } else {
    const res = await fetch(url + '/rest/v1/rpc/record_billing_charge', {
      method: 'POST',
      headers: { apikey: anon, Authorization: 'Bearer ' + anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_payment_intent: 'pi_verify_anon_' + STAMP, p_tenant: tenantId, p_month: month, p_volume_cents: 1, p_fee_cents: 0 }),
    });
    check(res.status >= 400, 'the public anon key cannot record a charge (' + res.status + ')', await res.text());
  }

  console.log('\n7. The order column exists');
  let hasColumn = true;
  try { await db.select('orders', { select: ['platform_fee_cents'], limit: 1 }); } catch { hasColumn = false; }
  check(hasColumn, 'orders.platform_fee_cents');

  await db.remove('tenant_billing_charges', { where: { payment_intent_id: like('pi_verify_%') } });
  const left = await db.select('tenant_billing_charges', { where: { payment_intent_id: like('pi_verify_%') }, select: ['payment_intent_id'], limit: 5 });
  check(left.length === 0, 'test rows removed');

  console.log('\n' + '='.repeat(74));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
