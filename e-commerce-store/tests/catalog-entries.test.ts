import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCategories, visibleProductCategories, filterStaleCatalogEntries } from '../lib/catalog-entries.ts';

// ── normalizeCategories ────────────────────────────────────────────────────
test('normalizeCategories trims, dedupes case-insensitively and strips long values', () => {
  assert.deepEqual(normalizeCategories([' Perfume ', 'perfume', 'Clothes', 'x'.repeat(41), '  ']), ['Perfume', 'Clothes']);
  assert.deepEqual(normalizeCategories('not-an-array'), []);
  assert.deepEqual(normalizeCategories([]), []);
  assert.deepEqual(normalizeCategories(undefined), []);
});

// ── visibleProductCategories (deleted categories disappear from products) ──
const ADMIN_CATS = ['New Arrivals', 'Limited Edition', 'Seasonal', 'Perfume'];

test('visibleProductCategories only keeps tags that still exist in the admin list', () => {
  const productTags = ['Perfume', 'Winter', 'Limited Edition', 'WINTER'];
  assert.deepEqual(visibleProductCategories(productTags, ADMIN_CATS), ['Perfume', 'Limited Edition']);
});

test('visibleProductCategories is case-insensitive both ways', () => {
  assert.deepEqual(visibleProductCategories(['perfume'], ['Perfume']), ['perfume']);
});

test('visibleProductCategories returns nothing when the category list is empty (all categories deleted)', () => {
  assert.deepEqual(visibleProductCategories(['Perfume', 'Clothes'], []), []);
  assert.deepEqual(visibleProductCategories(['Perfume'], undefined), []);
});

test('visibleProductCategories keeps nothing for an untagged product', () => {
  assert.deepEqual(visibleProductCategories([], ADMIN_CATS), []);
});

// ── filterStaleCatalogEntries (deleted products stop rendering) ────────────
const LIVE_PRODUCTS = [
  { id: 'p1', slug: 'elysian-white', name: 'Elysian White' },
  { id: 'p2', slug: 'noir-citrus', name: 'Noir Citrus' },
];

test('filterStaleCatalogEntries drops auto entries whose slug/name no longer resolves', () => {
  const configuredUpcoming = [
    { name: 'Elysian White', slug: 'elysian-white', status: 'Upcoming' }, // still live → keep
    { name: 'Deleted Drop', slug: 'deleted-drop', status: 'Upcoming' },    // product deleted → drop
    { name: 'Deleted Archive', slug: 'deleted-archive', status: 'Archived' },
  ];
  const kept = filterStaleCatalogEntries(configuredUpcoming, LIVE_PRODUCTS);
  assert.deepEqual(kept, [{ name: 'Elysian White', slug: 'elysian-white', status: 'Upcoming' }]);
});

test('filterStaleCatalogEntries always keeps manual entries (no slug field)', () => {
  const configuredArchive = [
    { name: 'Summer Collection', status: 'Archived', description: 'operator-typed, no slug' },
    { name: 'Noir Citrus', slug: 'noir-citrus', status: 'Archived' },
  ];
  const kept = filterStaleCatalogEntries(configuredArchive, LIVE_PRODUCTS);
  assert.equal(kept.length, 2);
});

test('filterStaleCatalogEntries matches by name as well as slug', () => {
  const entries = [{ name: 'Noir Citrus', slug: 'old-slug-renamed', status: 'Upcoming' }];
  assert.equal(filterStaleCatalogEntries(entries, LIVE_PRODUCTS).length, 1);
});

test('filterStaleCatalogEntries is safe with non-array inputs', () => {
  assert.deepEqual(filterStaleCatalogEntries(undefined, LIVE_PRODUCTS), []);
  assert.deepEqual(filterStaleCatalogEntries(null, LIVE_PRODUCTS), []);
});
