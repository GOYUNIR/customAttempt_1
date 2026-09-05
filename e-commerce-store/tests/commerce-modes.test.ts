import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMERCE_MODES,
  COMMERCE_MODE_META,
  sanitizeCommerceMode,
  commerceModeLabel,
  commerceModeMeta,
  commerceModeHasCapability,
  normalizeJsonBlock,
  normalizeCommerceConfig,
  validateCommerceConfig,
  commerceModeFromCheckoutMode,
  checkoutModeFromCommerceMode,
} from '../lib/commerce-modes.ts';

test('registry exposes exactly the 10 universal commerce modes', () => {
  assert.equal(COMMERCE_MODES.length, 10);
  assert.deepEqual(COMMERCE_MODES, [
    'INSTANT_BUY',
    'ALLOCATION_DRAW',
    'TIME_SLOT',
    'PREORDER',
    'SUBSCRIPTION',
    'GATED_ACCESS',
    'GROUP_BUY',
    'DUTCH_AUCTION',
    'PAY_WHAT_YOU_WANT',
    'RFQ_QUOTE',
  ]);
  for (const mode of COMMERCE_MODES) {
    assert.ok(COMMERCE_MODE_META[mode], `missing meta for ${mode}`);
    assert.ok(COMMERCE_MODE_META[mode].label.length > 0);
  }
});

test('sanitizeCommerceMode is case-insensitive and rejects unknown values', () => {
  assert.equal(sanitizeCommerceMode('instant_buy'), 'INSTANT_BUY');
  assert.equal(sanitizeCommerceMode('  allocation_draw '), 'ALLOCATION_DRAW');
  assert.equal(sanitizeCommerceMode('GroupBuy'), 'GROUP_BUY');
  assert.equal(sanitizeCommerceMode('nope'), null);
  assert.equal(sanitizeCommerceMode(''), null);
  assert.equal(sanitizeCommerceMode(null), null);
});

test('commerceModeLabel / commerceModeMeta resolve labels + capabilities', () => {
  assert.equal(commerceModeLabel('INSTANT_BUY'), 'Instant Buy');
  assert.equal(commerceModeLabel('ALLOCATION_DRAW'), 'Allocation Draw');
  assert.equal(commerceModeLabel('bogus'), '');
  assert.equal(commerceModeMeta('RFQ_QUOTE')?.description, 'Request-for-quote with manual pricing.');
  assert.equal(commerceModeHasCapability('SUBSCRIPTION', 'recurring'), true);
  assert.equal(commerceModeHasCapability('SUBSCRIPTION', 'inventory'), false);
  assert.equal(commerceModeHasCapability('bogus', 'recurring'), false);
});

test('normalizeJsonBlock coerces non-objects to {} and preserves objects', () => {
  assert.deepEqual(normalizeJsonBlock(null), {});
  assert.deepEqual(normalizeJsonBlock([]), {});
  assert.deepEqual(normalizeJsonBlock('x'), {});
  assert.deepEqual(normalizeJsonBlock({ a: 1 }), { a: 1 });
});

test('normalizeCommerceConfig sanitizes the mode and every block', () => {
  const cfg = normalizeCommerceConfig({
    commerceMode: 'group_buy',
    accessRule: { groupMinParticipants: 10 },
    billingRule: 'not-an-object',
    scheduleConfig: null,
    extraIgnored: true,
  });
  assert.equal(cfg.commerceMode, 'GROUP_BUY');
  assert.deepEqual(cfg.accessRule, { groupMinParticipants: 10 });
  assert.deepEqual(cfg.billingRule, {});
  assert.deepEqual(cfg.scheduleConfig, {});
});

test('validateCommerceConfig flags unknown modes and non-object blocks', () => {
  assert.equal(validateCommerceConfig({}).ok, true);
  assert.equal(validateCommerceConfig({ commerceMode: 'PREORDER', billingRule: { mode: 'on_fulfillment' } }).ok, true);

  const badMode = validateCommerceConfig({ commerceMode: 'NOT_A_MODE' });
  assert.equal(badMode.ok, false);
  assert.ok(badMode.errors.some((e) => e.includes('NOT_A_MODE')));

  const badBlock = validateCommerceConfig({ accessRule: [] });
  assert.equal(badBlock.ok, false);
  assert.ok(badBlock.errors.some((e) => e.includes('accessRule')));
});

test('checkout-mode ↔ commerce-mode mapping round-trips the retail pair', () => {
  assert.equal(commerceModeFromCheckoutMode('FCFS'), 'INSTANT_BUY');
  assert.equal(commerceModeFromCheckoutMode('RAFFLE'), 'ALLOCATION_DRAW');
  assert.equal(commerceModeFromCheckoutMode(undefined), 'ALLOCATION_DRAW');

  assert.equal(checkoutModeFromCommerceMode('INSTANT_BUY'), 'FCFS');
  assert.equal(checkoutModeFromCommerceMode('ALLOCATION_DRAW'), 'RAFFLE');
  assert.equal(checkoutModeFromCommerceMode('SUBSCRIPTION'), null);
  assert.equal(checkoutModeFromCommerceMode('bogus'), null);
});
