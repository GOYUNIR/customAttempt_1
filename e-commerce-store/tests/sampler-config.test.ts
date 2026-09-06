import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSamplerSizes,
  isSamplerSize,
  resolveSamplerConfig,
  formatMoneyCents,
  samplerPresentation,
  categorySampleBadge,
  resolveCategorySamplerConfig,
  categorySamplerPresentation,
  samplerPresentationSeed,
} from '../lib/sampler-config.ts';

const NOIR = {
  name: 'Noir Citrus',
  priceCategories: [
    { size: 'Sampler Set', price: 19, stripeId: '', winnerTiers: '0' },
    { size: 'Full Bottle', price: 145, stripeId: '', winnerTiers: '0' },
  ],
  deliveryIncentiveEnabled: true,
  deliveryIncentiveCreditCents: 1500,
  deliveryIncentiveMinOrderSubtotalCents: 9000,
  deliveryIncentiveExpiresDays: 60,
  deliveryIncentiveNeverExpires: false,
  deliveryIncentiveCodePrefix: 'NOIR',
  deliveryIncentiveEligibleProductSlugs: ['noir-citrus-instant-drop'],
  deliveryIncentiveEligibleSizes: ['Full Bottle'],
  samplerSizes: [
    {
      size: 'Sampler Set',
      label: 'Trial',
      fullSize: 'Full Bottle',
      creditCents: 2000,
      minOrderSubtotalCents: 8000,
      neverExpires: true,
      codePrefix: 'TRIAL',
      eligibleProductSlugs: ['noir-citrus-instant-drop'],
      eligibleSizes: ['Full Bottle'],
      note: 'Try before you commit.',
    },
  ],
};

test('normalizeSamplerSizes trims, dedupes, clamps and drops unknown sizes', () => {
  const out = normalizeSamplerSizes(
    [
      { size: '  Sampler Set  ', label: ' Trial ', creditCents: 1950 },
      { size: 'Sampler Set', creditCents: 0 },
      { size: 'Does Not Exist' },
      null,
      { size: 'Full Bottle', neverExpires: 'not-a-bool' },
    ],
    NOIR.priceCategories,
  );
  assert.equal(out.length, 2, 'unknown + duplicate sizes are dropped');
  assert.equal(out[0].size, 'Sampler Set');
  assert.equal(out[0].label, 'Trial');
  assert.equal(out[0].creditCents, 1950);
  assert.equal(out[1].neverExpires, null, 'non-boolean tri-state is normalized to null');
});

test('isSamplerSize honours the new config AND the legacy CSV', () => {
  assert.equal(isSamplerSize(NOIR, 'Sampler Set'), true);
  assert.equal(isSamplerSize(NOIR, 'sampler set'), true, 'case-insensitive');
  assert.equal(isSamplerSize(NOIR, 'Full Bottle'), false);
  // Legacy products (no samplerSizes) still resolve through deliveryIncentiveTriggerSizes.
  const legacy = { ...NOIR, samplerSizes: [], deliveryIncentiveTriggerSizes: ['Sampler Set'] };
  assert.equal(isSamplerSize(legacy, 'Sampler Set'), true);
  // Disabled credits never mark a size as a sampler.
  assert.equal(isSamplerSize({ ...NOIR, deliveryIncentiveEnabled: false }, 'Sampler Set'), false);
});

test('resolveSamplerConfig merges per-sampler overrides over product defaults', () => {
  const resolved = resolveSamplerConfig(NOIR, 'Sampler Set');
  assert.ok(resolved);
  assert.equal(resolved.label, 'Trial');
  assert.equal(resolved.fullSize, 'Full Bottle');
  assert.equal(resolved.creditCents, 2000, 'per-sampler credit wins over product default 1500');
  assert.equal(resolved.minOrderSubtotalCents, 8000);
  assert.equal(resolved.neverExpires, true);
  assert.equal(resolved.codePrefix, 'TRIAL');
  assert.deepEqual(resolved.eligibleSizes, ['Full Bottle']);
});

test('resolveSamplerConfig falls back to product defaults for blank fields', () => {
  const partial = {
    ...NOIR,
    samplerSizes: [{ size: 'Sampler Set', label: '', fullSize: '', creditCents: null }],
  };
  const resolved = resolveSamplerConfig(partial, 'Sampler Set');
  assert.ok(resolved);
  assert.equal(resolved.label, 'Sample', 'default badge label');
  assert.equal(resolved.fullSize, '', 'no target = any next order');
  assert.equal(resolved.creditCents, 1500, 'blank credit falls back to the product default');
  assert.equal(resolved.neverExpires, false, 'blank expiry falls back to the product default');
});

test('resolveSamplerConfig supports legacy trigger sizes without a sampler record', () => {
  const legacy = {
    ...NOIR,
    samplerSizes: [],
    deliveryIncentiveTriggerSizes: ['Sampler Set'],
  };
  const resolved = resolveSamplerConfig(legacy, 'Sampler Set');
  assert.ok(resolved);
  assert.equal(resolved.label, 'Sample');
  assert.equal(resolved.creditCents, 1500);
  assert.equal(resolveSamplerConfig(legacy, 'Full Bottle'), null);
  assert.equal(resolveSamplerConfig({ ...legacy, deliveryIncentiveEnabled: false }, 'Sampler Set'), null);
});

test('normalizeSamplerSizes + resolveSamplerConfig preserve the shared sample reference', () => {
  const linked = {
    ...NOIR,
    samplerSizes: [
      {
        size: 'Sampler Set',
        sampleRefId: 'noir-citrus-sample-kit',
        sampleRefName: 'Noir Citrus — Sample Kit',
      },
    ],
  };
  const normalized = normalizeSamplerSizes(linked.samplerSizes, NOIR.priceCategories);
  assert.equal(normalized[0].sampleRefId, 'noir-citrus-sample-kit');
  assert.equal(normalized[0].sampleRefName, 'Noir Citrus — Sample Kit');
  const resolved = resolveSamplerConfig(linked, 'Sampler Set');
  assert.ok(resolved);
  assert.equal(resolved.sampleRefId, 'noir-citrus-sample-kit');
  assert.equal(resolved.sampleRefName, 'Noir Citrus — Sample Kit');
});

test('formatMoneyCents renders whole dollars and cents cleanly', () => {
  assert.equal(formatMoneyCents(0), '$0');
  assert.equal(formatMoneyCents(1500), '$15');
  assert.equal(formatMoneyCents(1950), '$19.50');
  assert.equal(formatMoneyCents(-5), '$0');
});

test('samplerPresentation: selected sampler gets SPECIFIC per-size copy with exact math', () => {
  const pres = samplerPresentation(NOIR, 'Sampler Set');
  assert.equal(pres.enabled, true);
  assert.equal(pres.hasSamplers, true);
  assert.equal(pres.selected.isSampler, true);
  assert.equal(pres.selected.headline, 'Try the Trial first');
  assert.ok(pres.selected.body.includes('Sampler Set'), 'names the exact size');
  assert.ok(pres.selected.body.includes('$20'), 'names the per-sampler credit value');
  assert.ok(pres.selected.body.includes('Full Bottle'), 'names the upgrade target');
  assert.ok(pres.selected.math, 'math strip present');
  assert.equal(pres.selected.math!.samplePriceCents, 1900);
  assert.equal(pres.selected.math!.creditCents, 2000);
  assert.equal(pres.selected.math!.fullPriceCents, 14500);
  assert.equal(pres.selected.math!.remainingCents, 12500, 'full price minus credit');
  assert.equal(pres.selected.math!.pctCovered, 14);
  assert.equal(pres.selected.note, 'Try before you commit.');
  // The nudge must NOT appear for the selected sampler itself.
  assert.equal(pres.nudge, null);
});

test('samplerPresentation: non-sampler selection shows a gentle upgrade nudge, not the full card', () => {
  const pres = samplerPresentation(NOIR, 'Full Bottle');
  assert.equal(pres.selected.isSampler, false);
  assert.equal(pres.selected.headline, '');
  assert.ok(pres.nudge, 'nudge offered');
  assert.equal(pres.nudge!.size, 'Sampler Set');
  assert.equal(pres.nudge!.priceCents, 1900);
  assert.equal(pres.nudge!.creditCents, 2000);
  assert.equal(pres.nudge!.fullSize, 'Full Bottle');
});

test('samplerPresentation: the SAME product renders DIFFERENT copy per size', () => {
  const samplerCopy = samplerPresentation(NOIR, 'Sampler Set');
  const fullCopy = samplerPresentation(NOIR, 'Full Bottle');
  assert.notEqual(samplerCopy.selected.headline, fullCopy.selected.headline);
  assert.ok(samplerCopy.selected.body.length > 0);
  assert.equal(fullCopy.selected.body, '');
});

test('samplerPresentation: no samplers configured → nothing shown', () => {
  const plain = { ...NOIR, deliveryIncentiveEnabled: false };
  const pres = samplerPresentation(plain, 'Sampler Set');
  assert.equal(pres.enabled, false);
  assert.equal(pres.hasSamplers, false);
  assert.equal(pres.selected.isSampler, false);
  assert.equal(pres.nudge, null);
});


test('samplerPresentationSeed returns null for a non-sampler size and resolves prices for a sampler', () => {
  assert.equal(samplerPresentationSeed(NOIR, 'Full Bottle').sampler, null);
  const seed = samplerPresentationSeed(NOIR, 'Sampler Set');
  assert.ok(seed.sampler);
  assert.equal(seed.samplePriceCents, 1900);
  assert.equal(seed.fullPriceCents, 14500);
});

test('resolveCategorySamplerConfig reads a self-contained samplerConfig blob (slug-synced sample)', () => {
  const blob = {
    size: 'Discovery Kit',
    label: 'Discovery',
    fullSize: 'Full Bottle',
    creditCents: 2500,
    samplePriceCents: 2900,
    fullPriceCents: 14500,
  };
  const category = { size: 'Discovery Kit', samplerLabel: 'Discovery', samplerConfig: blob };
  // The parent product has NO sampler config of its own (delivery incentive off).
  const parent = { priceCategories: [category], deliveryIncentiveEnabled: false };
  const resolved = resolveCategorySamplerConfig(parent, category);
  assert.ok(resolved);
  assert.equal(resolved.label, 'Discovery');
  assert.equal(resolved.creditCents, 2500);
  assert.equal(resolved.fullSize, 'Full Bottle');
});

test('categorySamplerPresentation renders a synced sample incentive card with no local sampler', () => {
  const blob = {
    size: 'Discovery Kit',
    label: 'Discovery',
    fullSize: 'Full Bottle',
    creditCents: 2500,
    samplePriceCents: 2900,
    fullPriceCents: 14500,
  };
  const category = { size: 'Discovery Kit', price: 29, samplerLabel: 'Discovery', samplerConfig: blob };
  // A product that defines NO samplers and has delivery incentives OFF — the
  // synced variant must still render its badge + full incentive math.
  const parent = { priceCategories: [category], deliveryIncentiveEnabled: false, samplerSizes: [] };
  const pres = categorySamplerPresentation(parent, category);
  assert.equal(pres.enabled, true);
  assert.equal(pres.hasSamplers, true);
  assert.equal(pres.selected.isSampler, true);
  assert.equal(pres.selected.badge, 'Discovery');
  assert.ok(pres.selected.math);
  assert.equal(pres.selected.math.creditCents, 2500);
  assert.equal(pres.selected.math.remainingCents, 12000);
  assert.equal(categorySampleBadge(parent, category).label, 'Discovery');
});

