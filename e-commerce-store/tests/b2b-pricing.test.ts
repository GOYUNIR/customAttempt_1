import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveUnitPriceCents,
  tiersForVariant,
  effectiveQuoteLinePriceCents,
  quoteSubtotalCents,
  type PriceListEntry,
} from '../lib/b2b/pricing.ts';

const ENTRIES: PriceListEntry[] = [
  { variantId: 'v1', unitPriceCents: 900, minQuantity: 10 },
  { variantId: 'v1', unitPriceCents: 800, minQuantity: 50 },
  { variantId: 'v1', unitPriceCents: 700, minQuantity: 100 },
  { variantId: 'v2', unitPriceCents: 500, minQuantity: 5 },
];

test('below every tier minimum falls back to the base price', () => {
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v1', 5, 1000), 1000);
});

test('exactly at a tier minimum qualifies for that tier', () => {
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v1', 10, 1000), 900);
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v1', 50, 1000), 800);
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v1', 100, 1000), 700);
});

test('above the highest tier minimum keeps qualifying for the best tier', () => {
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v1', 500, 1000), 700);
});

test('between tiers resolves to the highest QUALIFYING tier, not the nearest', () => {
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v1', 75, 1000), 800);
});

test('a variant with no price-list entries falls back to base price', () => {
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v-unknown', 1000, 1234), 1234);
});

test('does not cross-apply another variant\'s tiers', () => {
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v2', 10, 1000), 500);
  assert.equal(resolveUnitPriceCents(ENTRIES, 'v1', 10, 1000), 900); // unaffected by v2's tier
});

test('malformed entries (negative price/quantity, non-finite) are ignored, never crash', () => {
  const dirty: PriceListEntry[] = [
    { variantId: 'v1', unitPriceCents: -5, minQuantity: 1 },
    { variantId: 'v1', unitPriceCents: NaN, minQuantity: 1 },
    { variantId: 'v1', unitPriceCents: 100, minQuantity: -1 },
  ];
  assert.equal(resolveUnitPriceCents(dirty, 'v1', 100, 999), 999);
});

test('tiersForVariant returns the ladder sorted ascending', () => {
  const tiers = tiersForVariant(ENTRIES, 'v1');
  assert.deepEqual(tiers.map((t) => t.minQuantity), [10, 50, 100]);
});

test('effectiveQuoteLinePriceCents: negotiated price wins when set', () => {
  assert.equal(effectiveQuoteLinePriceCents({ variantId: 'v1', quantity: 1, originalPriceCents: 1000, negotiatedPriceCents: 750 }), 750);
});

test('effectiveQuoteLinePriceCents: falls back to original when negotiated is null/undefined', () => {
  assert.equal(effectiveQuoteLinePriceCents({ variantId: 'v1', quantity: 1, originalPriceCents: 1000, negotiatedPriceCents: null }), 1000);
  assert.equal(effectiveQuoteLinePriceCents({ variantId: 'v1', quantity: 1, originalPriceCents: 1000 }), 1000);
});

test('effectiveQuoteLinePriceCents: a negative negotiated price is rejected, not applied', () => {
  assert.equal(effectiveQuoteLinePriceCents({ variantId: 'v1', quantity: 1, originalPriceCents: 1000, negotiatedPriceCents: -50 }), 1000);
});

test('quoteSubtotalCents sums quantity × effective unit price across lines', () => {
  const subtotal = quoteSubtotalCents([
    { variantId: 'v1', quantity: 3, originalPriceCents: 1000 },
    { variantId: 'v2', quantity: 2, originalPriceCents: 500, negotiatedPriceCents: 400 },
  ]);
  assert.equal(subtotal, 3 * 1000 + 2 * 400);
});
