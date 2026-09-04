import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_STATUSES,
  isProductStatus,
  normalizeProductStatus,
  statusFromLegacy,
  legacyBooleansFromStatus,
} from '../lib/product-status.ts';

test('status enum contains exactly DRAFT, ACTIVE, ARCHIVED', () => {
  assert.deepEqual([...PRODUCT_STATUSES], ['DRAFT', 'ACTIVE', 'ARCHIVED']);
  assert.equal(isProductStatus('DRAFT'), true);
  assert.equal(isProductStatus('ACTIVE'), true);
  assert.equal(isProductStatus('ARCHIVED'), true);
  assert.equal(isProductStatus('LIVE'), false);
  assert.equal(isProductStatus(null), false);
});

test('normalizeProductStatus upper-cases and falls back for junk', () => {
  assert.equal(normalizeProductStatus('draft'), 'DRAFT');
  assert.equal(normalizeProductStatus(' active '), 'ACTIVE');
  assert.equal(normalizeProductStatus('live', 'DRAFT'), 'DRAFT');
  assert.equal(normalizeProductStatus(undefined, 'ACTIVE'), 'ACTIVE');
  assert.equal(normalizeProductStatus(''), 'DRAFT');
});

test('statusFromLegacy: explicit status field wins over booleans', () => {
  assert.equal(statusFromLegacy({ status: 'ARCHIVED', isActive: true, isArchived: false }), 'ARCHIVED');
});

test('statusFromLegacy: archived is terminal (highest precedence)', () => {
  assert.equal(statusFromLegacy({ isArchived: true, isActive: true, isUpcoming: true }), 'ARCHIVED');
  assert.equal(statusFromLegacy({ isArchived: 'true' }), 'ARCHIVED');
});

test('statusFromLegacy: upcoming maps to DRAFT (hidden, not live)', () => {
  assert.equal(statusFromLegacy({ isUpcoming: true }), 'DRAFT');
  assert.equal(statusFromLegacy({ isUpcoming: true, isActive: true }), 'DRAFT');
});

test('statusFromLegacy: active vs hidden defaults', () => {
  assert.equal(statusFromLegacy({ isActive: true }), 'ACTIVE');
  assert.equal(statusFromLegacy({ isActive: false }), 'DRAFT');
  assert.equal(statusFromLegacy({}), 'ACTIVE'); // absent active = active (legacy default)
});

test('legacyBooleansFromStatus are mutually exclusive', () => {
  assert.deepEqual(legacyBooleansFromStatus('DRAFT'), { isActive: false, isArchived: false, isUpcoming: false });
  assert.deepEqual(legacyBooleansFromStatus('ACTIVE'), { isActive: true, isArchived: false, isUpcoming: false });
  assert.deepEqual(legacyBooleansFromStatus('ARCHIVED'), { isActive: false, isArchived: true, isUpcoming: false });
});
