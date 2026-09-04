import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inventoryPoolIdFromSyncSlug,
  resolveInventoryPoolId,
  inventoryPoolField,
  bindInventoryPoolToCategories,
  productHasInventoryPool,
} from '../lib/inventory-pool.ts';

test('inventoryPoolIdFromSyncSlug normalizes a slug into a stable id', () => {
  assert.equal(inventoryPoolIdFromSyncSlug('Black Tee / M'), 'black-tee-m');
  assert.equal(inventoryPoolIdFromSyncSlug('SAME_SLUG'), 'same-slug');
  assert.equal(inventoryPoolIdFromSyncSlug(''), '');
  assert.equal(inventoryPoolIdFromSyncSlug(null), '');
});

test('inventoryPoolField maps a pool id onto the shared: live-state field', () => {
  assert.equal(inventoryPoolField('black-tee'), 'shared:black-tee');
  assert.equal(inventoryPoolField('Black Tee!'), 'shared:black-tee');
  assert.equal(inventoryPoolField(''), '');
});

test('resolveInventoryPoolId finds a size’s pool id (explicit id or slug)', () => {
  const product = {
    checkoutMode: 'RAFFLE',
    priceCategories: [
      { size: 'Standard', price: 95, inventorySyncSlug: 'black-tee' },
      { size: 'Limited', price: 150, inventoryPoolId: 'gold-tee' },
      { size: 'Solo', price: 40 },
    ],
  };
  assert.equal(resolveInventoryPoolId(product, 'Standard'), 'black-tee');
  assert.equal(resolveInventoryPoolId(product, 'Limited'), 'gold-tee');
  assert.equal(resolveInventoryPoolId(product, 'Solo'), '');
  assert.equal(resolveInventoryPoolId(product, 'Missing'), '');
});

test('bindInventoryPoolToCategories sets inventoryPoolId and drops blanks', () => {
  const bound = bindInventoryPoolToCategories([
    { size: 'A', price: 10, inventorySyncSlug: 'Shared / Thing' },
    { size: 'B', price: 20, inventorySyncSlug: '' },
    { size: 'C', price: 30 },
  ]) as any[];
  assert.equal(bound[0].inventorySyncSlug, 'shared-thing');
  assert.equal(bound[0].inventoryPoolId, 'shared-thing');
  assert.equal('inventorySyncSlug' in bound[1], false);
  assert.equal('inventoryPoolId' in bound[1], false);
  assert.equal('inventoryPoolId' in bound[2], false);
});

test('productHasInventoryPool detects a linked size', () => {
  assert.equal(productHasInventoryPool({ priceCategories: [{ size: 'A', inventorySyncSlug: 'x' }] }), true);
  assert.equal(productHasInventoryPool({ priceCategories: [{ size: 'A' }] }), false);
  assert.equal(productHasInventoryPool({}), false);
});
