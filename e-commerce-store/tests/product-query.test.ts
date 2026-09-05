import test from 'node:test';
import assert from 'node:assert/strict';
import { queryProducts, filterProducts } from '../lib/product-query.ts';

const makeProducts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `prod_${i}`,
    name: `Product ${i}`,
    slug: `product-${i}`,
    sku: `SKU-${i}`,
    sortOrder: i,
    categories: i % 2 === 0 ? ['Tees'] : ['Hoodies'],
    checkoutMode: i % 3 === 0 ? 'FCFS' : 'RAFFLE',
    priceCategories: [{ size: 'M', price: 20 + i, sku: `SKU-M-${i}` }],
  }));

test('pagination: page + pageSize + totals + hasMore', () => {
  const products = makeProducts(30);
  const page1 = queryProducts(products, { page: 1, pageSize: 25 });
  assert.equal(page1.items.length, 25);
  assert.equal(page1.total, 30);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.items[0].name, 'Product 0');

  const page2 = queryProducts(products, { page: 2, pageSize: 25 });
  assert.equal(page2.items.length, 5);
  assert.equal(page2.hasMore, false);
});

test('fuzzy search matches title, slug and SKU tokens', () => {
  const products = makeProducts(30);
  assert.equal(queryProducts(products, { search: 'product 12' }).items[0]?.slug, 'product-12');
  assert.equal(queryProducts(products, { search: 'SKU-M-7' }).items[0]?.slug, 'product-7');
  assert.equal(queryProducts(products, { search: 'does-not-exist' }).total, 0);
});

test('status filter derives status from legacy booleans', () => {
  const products = [
    { name: 'Live', isActive: true },
    { name: 'Hidden', isActive: false },
    { name: 'Gone', isArchived: true },
  ];
  const active = queryProducts(products, { status: 'ACTIVE' });
  assert.deepEqual(active.items.map((p) => p.name), ['Live']);
  const archived = queryProducts(products, { status: 'ARCHIVED' });
  assert.deepEqual(archived.items.map((p) => p.name), ['Gone']);
  const draft = queryProducts(products, { status: 'DRAFT' });
  assert.deepEqual(draft.items.map((p) => p.name), ['Hidden']);
});

test('category filter is exact and case-insensitive', () => {
  const products = makeProducts(10);
  const tees = queryProducts(products, { category: 'tees' });
  assert.equal(tees.total, 5);
  assert.ok(tees.items.every((p) => p.categories.includes('Tees')));
});

test('checkoutMode filter supports RAFFLE, FCFS and MIXED', () => {
  const products = makeProducts(10);
  const fcfs = queryProducts(products, { checkoutMode: 'FCFS' });
  assert.ok(fcfs.items.every((p) => p.checkoutMode === 'FCFS'));
  const raffle = queryProducts(products, { checkoutMode: 'RAFFLE' });
  assert.ok(raffle.items.every((p) => p.checkoutMode === 'RAFFLE'));
});

test('hasInventoryPool filter', () => {
  const products = [
    { name: 'Pooled', priceCategories: [{ size: 'M', inventorySyncSlug: 'shared' }] },
    { name: 'Solo', priceCategories: [{ size: 'M' }] },
  ];
  assert.equal(queryProducts(products, { hasInventoryPool: true }).total, 1);
  assert.equal(queryProducts(products, { hasInventoryPool: 'true' }).items[0].name, 'Pooled');
});

test('page clamps to totalPages and pageSize clamps to 200', () => {
  const products = makeProducts(5);
  const over = queryProducts(products, { page: 99, pageSize: 25 });
  assert.equal(over.page, 1);
  assert.equal(over.items.length, 5);
  // A requested pageSize above the ceiling is clamped to 200, not 100.
  const big = queryProducts(products, { page: 1, pageSize: 100000 });
  assert.equal(big.pageSize, 200);
});

test('filterProducts returns the full filtered list without pagination', () => {
  const products = makeProducts(30);
  const all = filterProducts(products, { search: 'product' });
  assert.equal(all.length, 30);
});
