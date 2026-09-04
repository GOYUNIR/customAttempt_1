import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PRICE_CENTS,
  isSentinelPrice,
  isConfiguredPrice,
  parsePriceCents,
  validatePrice,
  validatePriceCategories,
} from '../lib/price-validation.ts';

test('validatePrice accepts real prices >= $0.01 and returns cents', () => {
  assert.deepEqual(validatePrice(0.01), { ok: true, cents: 1 });
  assert.deepEqual(validatePrice('19.99'), { ok: true, cents: 1999 });
  assert.deepEqual(validatePrice(145), { ok: true, cents: 14500 });
  assert.deepEqual(validatePrice('0.1'), { ok: true, cents: 10 });
});

test('validatePrice rejects the sentinel placeholder', () => {
  const res = validatePrice(9999999);
  assert.equal(res.ok, false);
  assert.equal(res.cents, null);
  assert.match(res.error || '', /placeholder/i);
});

test('validatePrice rejects zero and negative values', () => {
  assert.equal(validatePrice(0).ok, false);
  assert.equal(validatePrice(-5).ok, false);
  assert.match(validatePrice(0.005).error || '', /\$0\.01/);
  assert.match(validatePrice(0).error || '', /\$0\.01/);
});

test('validatePrice rejects non-numeric and empty', () => {
  assert.equal(validatePrice('abc').ok, false);
  assert.equal(validatePrice('').ok, false);
  assert.equal(validatePrice(null).ok, false);
  assert.equal(validatePrice(undefined).ok, false);
});

test('isSentinelPrice flags sentinels and non-prices', () => {
  assert.equal(isSentinelPrice(9999999), true);
  assert.equal(isSentinelPrice(10000000), true);
  assert.equal(isSentinelPrice(0), true);
  assert.equal(isSentinelPrice(-1), true);
  assert.equal(isSentinelPrice('nope'), true);
  assert.equal(isSentinelPrice(0.01), false);
  assert.equal(isSentinelPrice(99), false);
});

test('isConfiguredPrice matches validatePrice semantics', () => {
  assert.equal(isConfiguredPrice(0.01), true);
  assert.equal(isConfiguredPrice(19.99), true);
  assert.equal(isConfiguredPrice(0.009), false);
  assert.equal(isConfiguredPrice(9999999), false);
  assert.equal(isConfiguredPrice(0), false);
});

test('parsePriceCents returns null for invalid/sentinel', () => {
  assert.equal(parsePriceCents('19.99'), 1999);
  assert.equal(parsePriceCents(0.01), 1);
  assert.equal(parsePriceCents(9999999), null);
  assert.equal(parsePriceCents(''), null);
  assert.equal(parsePriceCents(0), null);
});

test('validatePriceCategories reports per-size errors', () => {
  const cats = [
    { size: '50ml', price: 95 },
    { size: '100ml', price: 9999999 },
    { size: 'Sampler', price: 0 },
  ];
  const res = validatePriceCategories(cats);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2);
  assert.equal(res.errors[0].size, '100ml');
  assert.equal(res.errors[1].size, 'Sampler');
  assert.equal(validatePriceCategories([{ size: '50ml', price: 0.5 }]).ok, true);
});

test('MIN_PRICE_CENTS is one cent', () => {
  assert.equal(MIN_PRICE_CENTS, 1);
});
