import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assignHoldout, isHeldOut, holdoutBucket, computeIncremental, methodologyNote,
  MIN_GROUP_FOR_CONFIDENCE,
} from '../lib/growth/holdout.ts';

test('assignment is STABLE — the same subject never changes group', () => {
  // The property the whole comparison depends on. A random draw per run would
  // leak the holdout away over time and turn the measurement into noise.
  for (const id of ['cart-1', 'cart-2', 'a@b.co', '00000000-0000-4000-8000-000000000001']) {
    const first = assignHoldout('cart_recovery', id, 8);
    for (let i = 0; i < 50; i += 1) {
      assert.equal(assignHoldout('cart_recovery', id, 8), first, `${id} flipped group`);
    }
  }
});

test('the split lands near the requested percentage across a population', () => {
  const N = 20_000;
  for (const pct of [5, 8, 10, 25]) {
    let control = 0;
    for (let i = 0; i < N; i += 1) {
      if (isHeldOut('cart_recovery', 'subject-' + i, pct)) control += 1;
    }
    const actual = (control / N) * 100;
    assert.ok(
      Math.abs(actual - pct) < 1.2,
      `holdout ${pct}% produced ${actual.toFixed(2)}% — too far off`,
    );
  }
});

test('a customer held out of one module is NOT held out of every module', () => {
  // Otherwise the same unlucky people are excluded from everything, and their
  // behaviour stops resembling the population the control group represents.
  const heldOutOfCart: string[] = [];
  for (let i = 0; i < 4000; i += 1) {
    const id = 'person-' + i;
    if (isHeldOut('cart_recovery', id, 10)) heldOutOfCart.push(id);
  }
  assert.ok(heldOutOfCart.length > 100, 'need a decent sample to test against');
  const alsoHeldOutElsewhere = heldOutOfCart.filter((id) => isHeldOut('back_in_stock', id, 10));
  const overlap = alsoHeldOutElsewhere.length / heldOutOfCart.length;
  // Independent modules should overlap at roughly the holdout rate (~10%),
  // not at 100% the way a shared assignment would.
  assert.ok(overlap < 0.25, `modules share holdouts too heavily (${(overlap * 100).toFixed(1)}%)`);
});

test('0% holdout treats everybody — which is what a deterministic module needs', () => {
  // Dunning must never withhold a failed-payment notice to measure itself.
  for (let i = 0; i < 500; i += 1) {
    assert.equal(assignHoldout('dunning', 'x' + i, 0), 'treated');
  }
  assert.equal(assignHoldout('anything', 'x', 100), 'control');
});

test('buckets are stable across calls and spread across the range', () => {
  assert.equal(holdoutBucket('m', 'subject'), holdoutBucket('m', 'subject'));
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i += 1) seen.add(holdoutBucket('m', 's' + i));
  assert.ok(seen.size > 900, 'buckets are clustering, not spreading');
});

test('incremental is computed PER HEAD, not as a raw difference', () => {
  // Groups are never the same size, so subtracting totals would credit the
  // module for the treated group simply being larger.
  const r = computeIncremental({
    treatedCount: 1000, controlCount: 100,
    treatedRevenueCents: 1_000_000,  // $100/head
    controlRevenueCents: 80_000,     // $80/head
  });
  assert.equal(r.treatedPerHead, 1000);
  assert.equal(r.controlPerHead, 800);
  // $20/head of lift across 1,000 treated = $200.00
  assert.equal(r.incrementalCents, 200_000);
  // Gross is the whole treated revenue — what a competitor would report.
  assert.equal(r.grossAttributedCents, 1_000_000);
  assert.ok(r.grossAttributedCents > r.incrementalCents, 'gross must exceed incremental here');
});

test('a module that did NOTHING reports zero, and one that HURT reports negative', () => {
  const same = computeIncremental({
    treatedCount: 500, controlCount: 500,
    treatedRevenueCents: 500_000, controlRevenueCents: 500_000,
  });
  assert.equal(same.incrementalCents, 0, 'no lift must read as no lift');

  const worse = computeIncremental({
    treatedCount: 500, controlCount: 500,
    treatedRevenueCents: 400_000, controlRevenueCents: 500_000,
  });
  assert.ok(worse.incrementalCents < 0, 'a harmful module must be able to say so');
});

test('a control group too small to conclude from says so instead of claiming', () => {
  const tiny = computeIncremental({
    treatedCount: 200, controlCount: 9,
    treatedRevenueCents: 400_000, controlRevenueCents: 9_000,
  });
  assert.equal(tiny.reliable, false);
  assert.match(String(tiny.caveat), /early signal, not a result/);

  const big = computeIncremental({
    treatedCount: 500, controlCount: MIN_GROUP_FOR_CONFIDENCE,
    treatedRevenueCents: 500_000, controlRevenueCents: 30_000,
  });
  assert.equal(big.reliable, true);
  assert.equal(big.caveat, null);
});

test('no control group means no claim — but gross is still reported honestly', () => {
  const none = computeIncremental({
    treatedCount: 900, controlCount: 0,
    treatedRevenueCents: 900_000, controlRevenueCents: 0,
  });
  assert.equal(none.incrementalCents, 0, 'must not invent a lift');
  assert.equal(none.grossAttributedCents, 900_000, 'gross is real, it just is not causal');
  assert.equal(none.reliable, false);
  assert.match(String(none.caveat), /No control group/);
});

test('the methodology note states the method, not a link to it', () => {
  const note = methodologyNote(8, 72);
  assert.match(note, /8%/);
  assert.match(note, /72 hours/);
  assert.match(note, /stable hash/);
  // A merchant must be able to check the arithmetic from this sentence alone.
  assert.match(note, /difference in revenue per person/);
});
