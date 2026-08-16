import test from 'node:test';
import assert from 'node:assert/strict';
import { getSizeCheckoutMode, hasMixedCheckoutModes, sizeCheckoutModes } from '../lib/checkout-mode.ts';

// A mixed-format product: sampler sells instantly (FCFS), full size runs a raffle.
const MIXED = {
  name: 'Noir Citrus — Instant Drop',
  checkoutMode: 'RAFFLE',
  isRaffle: true,
  priceCategories: [
    { size: 'Sampler Set', price: 19, checkoutMode: 'FCFS' },
    { size: 'Full Bottle', price: 145, checkoutMode: 'RAFFLE' },
  ],
};

// A plain raffle product (no per-size overrides).
const PLAIN_RAFFLE = {
  name: 'Elysian White',
  checkoutMode: 'RAFFLE',
  isRaffle: true,
  priceCategories: [
    { size: '50ml', price: 130 },
    { size: '100ml', price: 190 },
  ],
};

// A plain FCFS product (no per-size overrides).
const PLAIN_FCFS = {
  name: 'Obsidian Void',
  checkoutMode: 'FCFS',
  isRaffle: false,
  priceCategories: [
    { size: 'Standard', price: 80 },
  ],
};

test('getSizeCheckoutMode: per-size override wins on a mixed product', () => {
  assert.equal(getSizeCheckoutMode(MIXED, 'Sampler Set'), 'FCFS');
  assert.equal(getSizeCheckoutMode(MIXED, 'Full Bottle'), 'RAFFLE');
});

test('getSizeCheckoutMode: product-level default applies when a size has no override', () => {
  assert.equal(getSizeCheckoutMode(PLAIN_RAFFLE, '50ml'), 'RAFFLE');
  assert.equal(getSizeCheckoutMode(PLAIN_RAFFLE, '100ml'), 'RAFFLE');
  assert.equal(getSizeCheckoutMode(PLAIN_FCFS, 'Standard'), 'FCFS');
});

test('getSizeCheckoutMode: case-insensitive + trimmed size lookup', () => {
  assert.equal(getSizeCheckoutMode(MIXED, '  sampler set  '), 'FCFS');
  assert.equal(getSizeCheckoutMode(MIXED, 'FULL BOTTLE'), 'RAFFLE');
});

test('getSizeCheckoutMode: unknown size falls back to the product default', () => {
  assert.equal(getSizeCheckoutMode(MIXED, '3 Litre'), 'RAFFLE');
  assert.equal(getSizeCheckoutMode(PLAIN_FCFS, 'X-Large'), 'FCFS');
});

test('getSizeCheckoutMode: legacy isRaffle:false + productType fallbacks', () => {
  const legacy = { name: 'x', isRaffle: false, priceCategories: [{ size: 'Standard', price: 10 }] };
  assert.equal(getSizeCheckoutMode(legacy, 'Standard'), 'FCFS');
  const legacyType = { name: 'x', productType: 'fcfs', priceCategories: [{ size: 'Standard', price: 10 }] };
  assert.equal(getSizeCheckoutMode(legacyType, 'Standard'), 'FCFS');
});

test('getSizeCheckoutMode: per-size override works even when the product default is FCFS', () => {
  const mixedOther = {
    ...PLAIN_FCFS,
    priceCategories: [
      { size: 'Standard', price: 80, checkoutMode: 'FCFS' },
      { size: 'Limited', price: 200, checkoutMode: 'RAFFLE' },
    ],
  };
  assert.equal(getSizeCheckoutMode(mixedOther, 'Standard'), 'FCFS');
  assert.equal(getSizeCheckoutMode(mixedOther, 'Limited'), 'RAFFLE');
});

test('hasMixedCheckoutModes: true only when both modes are present', () => {
  assert.equal(hasMixedCheckoutModes(MIXED), true);
  assert.equal(hasMixedCheckoutModes(PLAIN_RAFFLE), false);
  assert.equal(hasMixedCheckoutModes(PLAIN_FCFS), false);
  assert.equal(hasMixedCheckoutModes({ priceCategories: [] }), false);
});

test('sizeCheckoutModes: returns a size → mode map', () => {
  const map = sizeCheckoutModes(MIXED);
  assert.deepEqual(map, { 'Sampler Set': 'FCFS', 'Full Bottle': 'RAFFLE' });
});

test('sizeCheckoutModes: every size resolves even without per-size overrides', () => {
  const map = sizeCheckoutModes(PLAIN_RAFFLE);
  assert.deepEqual(map, { '50ml': 'RAFFLE', '100ml': 'RAFFLE' });
});
