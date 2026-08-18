import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkProductSanity,
  checkRewardsSanity,
  parseWinnerTiers,
  totalWinnersForTiers,
  sortSanityIssues,
  severityLabel,
  type SanityIssue,
} from '../lib/product-sanity.ts';

const NOW = Date.parse('2026-08-18T12:00:00Z');

const BASE_PRODUCT: any = {
  id: 'p1',
  name: 'Test Drop',
  isActive: true,
  totalInventory: 100,
  priceCategories: [{ size: 'Standard', price: 95, stripeId: 'price_x', winnerTiers: '2,1' }],
};

const issueCodes = (issues: SanityIssue[]) => issues.map((i) => i.code);

test('parseWinnerTiers handles CSV strings and arrays', () => {
  assert.deepEqual(parseWinnerTiers('3,2,2'), [3, 2, 2]);
  assert.deepEqual(parseWinnerTiers([3, 2, 2]), [3, 2, 2]);
  assert.deepEqual(parseWinnerTiers('0'), []);
  assert.deepEqual(parseWinnerTiers(''), []);
  assert.deepEqual(parseWinnerTiers('a,b'), []);
  assert.equal(totalWinnersForTiers('3,2,2'), 7);
  assert.equal(totalWinnersForTiers([2]), 2);
});

test('a healthy product passes with no blocking issues', () => {
  const issues = checkProductSanity({ ...BASE_PRODUCT }, { now: NOW, globalStripeConfigured: true });
  assert.equal(issues.filter((i) => i.severity === 'error').length, 0);
});

test('missing sizes is a blocking error', () => {
  const issues = checkProductSanity({ ...BASE_PRODUCT, priceCategories: [] }, { now: NOW });
  assert.ok(issues.some((i) => i.code === 'no_sizes' && i.severity === 'error'));
});

test('duplicate sizes are a blocking error', () => {
  const issues = checkProductSanity(
    { ...BASE_PRODUCT, priceCategories: [
      { size: 'Standard', price: 95, stripeId: 'a', winnerTiers: '1' },
      { size: 'Standard', price: 120, stripeId: 'b', winnerTiers: '1' },
    ] },
    { now: NOW, globalStripeConfigured: true },
  );
  assert.ok(issues.some((i) => i.code === 'duplicate_size' && i.severity === 'error'));
});

test('a $0 price is a blocking error', () => {
  const issues = checkProductSanity(
    { ...BASE_PRODUCT, priceCategories: [{ size: 'Standard', price: 0, stripeId: 'a', winnerTiers: '1' }] },
    { now: NOW, globalStripeConfigured: true },
  );
  assert.ok(issues.some((i) => i.code === 'empty_price' && i.severity === 'error'));
});

test('raffle winners that exceed inventory are a blocking error', () => {
  const issues = checkProductSanity(
    { ...BASE_PRODUCT, totalInventory: 5, priceCategories: [{ size: 'Standard', price: 95, stripeId: 'a', winnerTiers: '4,4' }] },
    { now: NOW, globalStripeConfigured: true },
  );
  const oversell = issues.find((i) => i.code === 'raffle_oversell');
  assert.ok(oversell, 'expected raffle_oversell');
  assert.equal(oversell!.severity, 'error');
});

test('winners on an FCFS size is a warning', () => {
  const issues = checkProductSanity(
    {
      ...BASE_PRODUCT,
      checkoutMode: 'FCFS',
      priceCategories: [{ size: 'Standard', price: 95, stripeId: 'a', winnerTiers: '3' }],
    },
    { now: NOW, globalStripeConfigured: true },
  );
  assert.ok(issues.some((i) => i.code === 'winners_on_fcfs' && i.severity === 'warning'));
});

test('sampler credit ≥ sampler price is a BLOCKING exploit', () => {
  const issues = checkProductSanity(
    {
      ...BASE_PRODUCT,
      deliveryIncentiveEnabled: true,
      priceCategories: [
        { size: 'Trial', price: 19, stripeId: 'a', winnerTiers: '0', checkoutMode: 'FCFS' },
        { size: 'Full', price: 145, stripeId: 'b', winnerTiers: '1' },
      ],
      samplerSizes: [{ size: 'Trial', label: 'Trial', fullSize: 'Full', creditCents: 2000, minOrderSubtotalCents: 9000 }],
    },
    { now: NOW, globalStripeConfigured: true },
  );
  const arb = issues.find((i) => i.code === 'sampler_arbitrage');
  assert.ok(arb, 'expected sampler_arbitrage');
  assert.equal(arb!.severity, 'error');
});

test('missing Stripe IDs without a global fallback warn; with a fallback they do not', () => {
  const noFallback = checkProductSanity(
    { ...BASE_PRODUCT, priceCategories: [{ size: 'Standard', price: 95, winnerTiers: '1' }] },
    { now: NOW, globalStripeConfigured: false },
  );
  assert.ok(noFallback.some((i) => i.code === 'no_stripe'));

  const withFallback = checkProductSanity(
    { ...BASE_PRODUCT, priceCategories: [{ size: 'Standard', price: 95, winnerTiers: '1' }] },
    { now: NOW, globalStripeConfigured: true },
  );
  assert.ok(!withFallback.some((i) => i.code === 'no_stripe'));
});

test('checkRewardsSanity flags reward arbitrage + gift abuse', () => {
  const arbitrage = checkRewardsSanity({ purchasePointsPerDollar: 100, pointsPerDollar: 50 });
  assert.ok(arbitrage.some((i) => i.code === 'reward_arbitrage' && i.severity === 'error'));

  const thin = checkRewardsSanity({ purchasePointsPerDollar: 60, pointsPerDollar: 100 });
  assert.ok(thin.some((i) => i.code === 'reward_thin_margin' && i.severity === 'warning'));

  const gift = checkRewardsSanity({ purchasePointsPerDollar: 10, pointsPerDollar: 100, giftDiscountPercent: 100 });
  assert.ok(gift.some((i) => i.code === 'gift_full_value' && i.severity === 'error'));

  const clean = checkRewardsSanity({ purchasePointsPerDollar: 10, pointsPerDollar: 100, giftDiscountPercent: 10 });
  assert.equal(clean.filter((i) => i.severity === 'error').length, 0);
  assert.equal(clean.filter((i) => i.severity === 'warning').length, 0);
});

test('sortSanityIssues orders errors before warnings before info', () => {
  const sorted = sortSanityIssues([
    { severity: 'info', code: 'i', message: 'i' },
    { severity: 'warning', code: 'w', message: 'w' },
    { severity: 'error', code: 'e', message: 'e' },
  ]);
  assert.deepEqual(issueCodes(sorted), ['e', 'w', 'i']);
  assert.equal(severityLabel('error'), 'Blocking');
});

