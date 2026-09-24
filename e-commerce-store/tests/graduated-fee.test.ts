import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  feeForChargeCents, graduatedSchedule, monthlyFeeCents, monthStanding, type FeePlan,
} from '../lib/pricing/graduated-fee.ts';

// The decided plans (owner, 2026-09-24): Free 2%, $29 + 0.5%, $99 + 0%.
// Scale has no published price and must be ignored.
const PLANS: FeePlan[] = [
  { id: 'free', monthlyCents: 0, feeBps: 200 },
  { id: 'starter', monthlyCents: 2900, feeBps: 50 },
  { id: 'growth', monthlyCents: 9900, feeBps: 0 },
  { id: 'scale', monthlyCents: null, feeBps: 0 },
];

// Deterministic PRNG so a failure is reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('the month fee is the cheapest plan for the volume actually done', () => {
  for (const [volume, expected] of [
    [0, 0],
    [50_000, 1000],        // $500: 2% = $10
    [193_333, 3867],       // just under the first breakpoint: 2% = $38.67
    [300_000, 4400],       // $3,000: $29 + 0.5% = $44
    [1_400_000, 9900],     // $14,000: $29 + $70 = $99 = Growth
    [5_000_000, 9900],     // $50,000: capped at $99
  ] as const) {
    const cheapest = Math.min(0.02 * volume, 2900 + 0.005 * volume, 9900);
    assert.equal(monthlyFeeCents(PLANS, volume), expected, 'volume ' + volume);
    assert.ok(Math.abs(monthlyFeeCents(PLANS, volume) - cheapest) <= 0.5, 'matches min of plans at ' + volume);
  }
});

test('THE PROPERTY: per-sale fees add up to the month fee exactly, however the month is split', () => {
  const r = rng(42);
  for (let trial = 0; trial < 500; trial += 1) {
    const sales = Array.from({ length: 1 + Math.floor(r() * 80) }, () => 1 + Math.floor(r() * 90_000));
    let mtd = 0;
    let collected = 0;
    for (const amount of sales) {
      const fee = feeForChargeCents(PLANS, mtd, amount);
      assert.ok(Number.isInteger(fee) && fee >= 0, 'fee is whole, non-negative cents');
      collected += fee;
      mtd += amount;
    }
    assert.equal(collected, monthlyFeeCents(PLANS, mtd), 'trial ' + trial + ': ' + sales.length + ' sales');
  }
});

test('never more than the flat-price plan in a month, however large', () => {
  let mtd = 0;
  let collected = 0;
  for (let i = 0; i < 2000; i += 1) {
    collected += feeForChargeCents(PLANS, mtd, 25_000);
    mtd += 25_000;
  }
  assert.equal(mtd, 50_000_000);
  assert.equal(collected, 9900);
});

test('a sale that straddles a breakpoint pays each rate on its own share', () => {
  // $1,900 so far; a $100 sale: $33.33 at 2% + $66.67 at 0.5% = $1.00, not $2.00.
  assert.equal(feeForChargeCents(PLANS, 190_000, 10_000), 100);
  // Entirely inside the 0.5% band.
  assert.equal(feeForChargeCents(PLANS, 500_000, 10_000), 50);
  // Past the ceiling: fee-free.
  assert.equal(feeForChargeCents(PLANS, 1_500_000, 10_000), 0);
});

test('the schedule is derived from the plans: 2% -> 0.5% at $1,933.34 -> 0% at $14,000', () => {
  assert.deepEqual(graduatedSchedule(PLANS), [
    { fromCents: 0, toCents: 193_334, bps: 200, planId: 'free' },
    { fromCents: 193_334, toCents: 1_400_000, bps: 50, planId: 'starter' },
    { fromCents: 1_400_000, toCents: null, bps: 0, planId: 'growth' },
  ]);
});

test('breakpoints move when a price moves — nothing is configured twice', () => {
  const cheaperStarter = PLANS.map((p) => (p.id === 'starter' ? { ...p, monthlyCents: 1900 } : p));
  const [first] = graduatedSchedule(cheaperStarter);
  assert.equal(first.toCents, 126_667); // 1900 / 0.015 = $1,266.67
});

test('a plan that is never cheapest simply never appears', () => {
  const pricey = PLANS.map((p) => (p.id === 'starter' ? { ...p, monthlyCents: 9000 } : p));
  assert.deepEqual(graduatedSchedule(pricey).map((t) => t.planId), ['free', 'growth']);
});

test('refuses a plan set it cannot honour', () => {
  assert.throws(() => monthlyFeeCents([{ id: 'x', monthlyCents: 2900, feeBps: 50 }], 1000), /price of 0/);
  assert.throws(() => monthlyFeeCents([{ id: 'x', monthlyCents: null, feeBps: 0 }], 1000), /no priced plans/);
});

test('the milestone numbers a merchant would see', () => {
  const early = monthStanding(PLANS, 150_000); // $1,500 so far
  assert.equal(early.currentBps, 200);
  assert.equal(early.nextBps, 50);
  assert.equal(early.toNextTierCents, 43_334); // $433.34 more and the rate drops
  assert.equal(early.atCeiling, false);

  const capped = monthStanding(PLANS, 2_000_000); // $20,000 so far
  assert.equal(capped.feeCents, 9900);
  assert.equal(capped.atCeiling, true);
  assert.equal(capped.effectiveBps, 50); // $99 on $20,000 = 0.495% -> 50 bps
});

// The published plans themselves, not a copy of them: if someone edits a price
// or a rate in lib/platform-marketing.ts, this is where the schedule it implies
// gets checked.
test('the published pricing data produces the decided schedule', async () => {
  const { PLANS: PUBLISHED } = await import('../lib/platform-marketing.ts');
  const feePlans: FeePlan[] = PUBLISHED
    .filter((p: any) => p.monthlyUsd !== null && typeof p.platformFeeBps === 'number')
    .map((p: any) => ({ id: p.id, monthlyCents: Math.round(p.monthlyUsd * 100), feeBps: p.platformFeeBps }));
  assert.deepEqual(feePlans.map((p) => p.id), ['free', 'starter', 'growth']);
  assert.deepEqual(graduatedSchedule(feePlans).map((t) => [t.planId, t.bps, t.toCents]), [
    ['free', 200, 193_334],
    ['starter', 50, 1_400_000],
    ['growth', 0, null],
  ]);
});
