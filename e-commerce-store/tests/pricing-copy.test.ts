import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, feeSummary, plansWithData } from '../lib/platform-marketing.ts';
import { monthlyFeeCents, type FeePlan } from '../lib/pricing/graduated-fee.ts';

// DEFERRED-9: the pricing page once implied there was no per-sale fee while
// every merchant sale carried one. The fee copy is now DERIVED from the plan
// data; these pin that it states the real schedule and promises nothing the
// product cannot do yet.
const feePlans: FeePlan[] = PLANS.filter((p) => p.monthlyUsd !== null && p.platformFeeBps !== undefined)
  .map((p) => ({ id: p.id, monthlyCents: Math.round((p.monthlyUsd as number) * 100), feeBps: p.platformFeeBps as number }));

test('the fee copy states the schedule the engine actually charges', () => {
  const { freeLine, footnote } = feeSummary();
  const cap = monthlyFeeCents(feePlans, 10_000_000); // a huge month hits the cap
  assert.ok(freeLine.includes('2%') && freeLine.includes('0.5%'), freeLine);
  assert.ok(freeLine.includes('$' + (cap / 100).toFixed(0)), 'the cap the engine applies: ' + cap);
  assert.ok(/fee from each sale/.test(footnote) && /never charge a share of the revenue/.test(footnote), 'fee disclosed, attribution promise kept separate');
});

test('the page shows Free, Growth and Scale (owner decision D2)', () => {
  assert.deepEqual(PLANS.filter((p) => p.listed !== false).map((p) => p.id), ['free', 'growth', 'scale']);
});

test('no listed plan offers a trial; Growth is self-serve (plan billing, PRICING.md §9)', () => {
  assert.ok(PLANS.find((p) => p.id === 'growth')?.contactOnly !== true, 'Growth is bought from the dashboard');
  for (const p of PLANS.filter((x) => x.listed !== false && (x.monthlyUsd || 0) > 0)) {
    assert.ok(!p.trialDays && !/trial/i.test(String(p.priceNote) + String(p.ctaLabel)), p.id + ' must not promise a trial');
  }
});

test('the page takes its numbers from the plans table (what billing charges)', () => {
  const rows = [
    { id: 'free', name: 'Free', baseCents: 0, platformFeeBps: 300, feeMode: 'graduated', listed: true },
    { id: 'starter', name: 'Starter', baseCents: 2900, platformFeeBps: 50, feeMode: 'flat', listed: false },
    { id: 'growth', name: 'Growth', baseCents: 12900, platformFeeBps: 0, feeMode: 'flat', listed: true },
    { id: 'scale', name: 'Scale', baseCents: 0, platformFeeBps: null, feeMode: 'custom', listed: true },
  ];
  const plans = plansWithData(rows);
  assert.equal(plans.find((p) => p.id === 'growth')?.monthlyUsd, 129, 'a price change in the data moves the page');
  assert.equal(plans.find((p) => p.id === 'scale')?.monthlyUsd, null, 'custom = talk to us');
  assert.equal(plans.find((p) => p.id === 'starter')?.listed, false);
  const fees = feeSummary(plans);
  assert.match(fees.freeLine, /3%/, 'the fee line follows the data: ' + fees.freeLine);
  assert.match(fees.freeLine, /\$129/);
  assert.deepEqual(plansWithData([]), PLANS, 'no rows: the built-in numbers');
});
