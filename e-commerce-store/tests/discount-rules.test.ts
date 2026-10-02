import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, validateDiscountInput, normalizeCode, minChargeCents } from '../lib/discount-rules.ts';

test('percent off a single item', () => {
  const r = applyDiscount({ kind: 'percent', percentBps: 1000 }, [{ unitCents: 1900, quantity: 1 }], 'usd');
  assert.deepEqual([r.discountCents, r.lines[0].unitCents, r.capped], [190, 1710, false]);
});

test('a fixed amount is spread over a cart in proportion, and the lines add up exactly', () => {
  const r = applyDiscount({ kind: 'fixed', amountCents: 1000 }, [{ unitCents: 3000, quantity: 1 }, { unitCents: 1000, quantity: 1 }], 'usd');
  assert.equal(r.discountCents, 1000);
  assert.deepEqual(r.lines.map((l) => l.unitCents), [2250, 750]);
  assert.equal(r.subtotalCents - r.lines.reduce((s, l) => s + l.unitCents * l.quantity, 0), r.discountCents);
});

test('per unit: quantity 3 can only take whole cents per unit, so the discount is a few cents under, never over', () => {
  const r = applyDiscount({ kind: 'fixed', amountCents: 100 }, [{ unitCents: 1000, quantity: 3 }], 'usd');
  assert.equal(r.lines[0].unitCents, 967);
  assert.equal(r.discountCents, 99);
  assert.ok(r.discountCents <= 100);
});

test('NEVER below Stripe\'s minimum charge: the discount is capped', () => {
  const r = applyDiscount({ kind: 'fixed', amountCents: 5000 }, [{ unitCents: 1900, quantity: 1 }], 'usd');
  assert.equal(r.lines[0].unitCents, 50, 'the total stays at $0.50');
  assert.equal(r.discountCents, 1850);
  assert.equal(r.capped, true);
  const tiny = applyDiscount({ kind: 'percent', percentBps: 9000 }, [{ unitCents: 40, quantity: 1 }], 'usd');
  assert.deepEqual([tiny.discountCents, tiny.lines[0].unitCents], [0, 40], 'an order already under the minimum gets nothing off');
  const gbp = applyDiscount({ kind: 'percent', percentBps: 9000 }, [{ unitCents: 100, quantity: 1 }], 'gbp');
  assert.equal(gbp.lines[0].unitCents, 30, 'per currency (GBP 30p)');
});

test('at most 90% even if the data says more', () => {
  assert.equal(applyDiscount({ kind: 'percent', percentBps: 10000 }, [{ unitCents: 10000, quantity: 1 }], 'usd').discountCents, 9000);
});

test('the merchant\'s form: valid codes, and refusals', () => {
  const ok = validateDiscountInput({ code: ' spring-10 ', kind: 'percent', amount: 10 });
  assert.ok(ok.ok && ok.value.code === 'SPRING-10' && ok.value.percentBps === 1000 && ok.value.maxUsesPerCustomer === 1 && ok.value.maxUses === null);
  const fixed = validateDiscountInput({ code: 'FIVE', kind: 'fixed', amount: 5, minSubtotal: 25, maxUses: 100, endsAt: '2027-01-01' });
  assert.ok(fixed.ok && fixed.value.amountCents === 500 && fixed.value.minSubtotalCents === 2500 && fixed.value.maxUses === 100);
  for (const bad of [{ code: 'AB', kind: 'percent', amount: 10 }, { code: 'GOOD', kind: 'percent', amount: 95 }, { code: 'GOOD', kind: 'percent', amount: 0 },
    { code: 'GOOD', kind: 'fixed', amount: -1 }, { code: 'GOOD', kind: 'bogus', amount: 5 }, { code: 'BAD CODE!', kind: 'percent', amount: 5 },
    { code: 'GOOD', kind: 'percent', amount: 5, maxUses: 0 }, { code: 'GOOD', kind: 'percent', amount: 5, startsAt: '2027-02-01', endsAt: '2027-01-01' }])
    assert.equal(validateDiscountInput(bad).ok, false, JSON.stringify(bad));
  assert.equal(normalizeCode(' welcome 10 '), 'WELCOME10');
  assert.equal(minChargeCents('XYZ'), 50);
});
