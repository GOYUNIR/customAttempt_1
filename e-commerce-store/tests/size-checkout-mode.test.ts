import test from 'node:test';
import assert from 'node:assert/strict';
import { getSizeCheckoutMode, getCategoryCheckoutMode, hasMixedCheckoutModes, sizeCheckoutModes, resolveSizeLimits, resolveCategoryLimits, normalizeInventorySyncSlug, resolveInventorySyncSlug, sharedInventoryField, isSyncedSourceReleased, categoryMatchesInventorySyncSlug, productMatchesInventorySyncSlug, findInventorySyncSource } from '../lib/checkout-mode.ts';

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

test('resolveSizeLimits: per-size values win, product-level fallback otherwise', () => {
  const product = {
    totalInventory: 100,
    maxPerEmail: 2,
    maxPerCart: 3,
    maxRaffleAllocationLimit: 50,
    inventoryPerSize: { 'Small': 12, 'Large': 40 },
    priceCategories: [
      { size: 'Small', price: 10, maxPerEmail: 5, maxPerCart: 7, maxRaffleAllocationLimit: 20 },
      { size: 'Large', price: 20 },
    ],
  };
  const small = resolveSizeLimits(product, 'Small');
  assert.equal(small.maxPerEmail, 5);
  assert.equal(small.maxPerCart, 7);
  assert.equal(small.maxRaffleAllocationLimit, 20);
  assert.equal(small.inventory, 12);

  const large = resolveSizeLimits(product, 'Large');
  assert.equal(large.maxPerEmail, 2);
  assert.equal(large.maxPerCart, 3);
  assert.equal(large.maxRaffleAllocationLimit, 50);
  assert.equal(large.inventory, 40);

  // A size with no per-size stock and no product fallback for a field.
  const minimal = resolveSizeLimits({ priceCategories: [{ size: 'X' }] }, 'X');
  assert.equal(minimal.maxPerEmail, 1);
  assert.equal(minimal.maxPerCart, 1);
  assert.equal(minimal.maxRaffleAllocationLimit, 0);
  assert.equal(minimal.inventory, 0);
});

test('getCategoryCheckoutMode: resolves a duplicate-size variant by its OWN object, not the size string', () => {
  // Two variants share the SAME size label but different modes. A size-string
  // lookup would always resolve the FIRST one; the category-object resolver must
  // return each variant's OWN mode.
  const dup = {
    name: 'Collision',
    checkoutMode: 'RAFFLE',
    priceCategories: [
      { size: 'Standard', price: 149, checkoutMode: 'RAFFLE' },
      { size: 'Standard', price: 19, checkoutMode: 'FCFS' },
    ],
  };
  assert.equal(getCategoryCheckoutMode(dup, dup.priceCategories[0]), 'RAFFLE');
  assert.equal(getCategoryCheckoutMode(dup, dup.priceCategories[1]), 'FCFS');
});

test('getCategoryCheckoutMode: falls back to the product mode when the variant has none', () => {
  const cat = { size: 'Standard', price: 50 };
  assert.equal(getCategoryCheckoutMode(PLAIN_FCFS, cat), 'FCFS');
  assert.equal(getCategoryCheckoutMode(PLAIN_RAFFLE, cat), 'RAFFLE');
});

test('resolveCategoryLimits: resolves a duplicate-size variant by its OWN object', () => {
  const dup = {
    totalInventory: 100,
    maxPerEmail: 2,
    maxPerCart: 3,
    inventoryPerSize: {},
    priceCategories: [
      { size: 'Standard', price: 149, maxPerEmail: 10, maxPerCart: 10, maxRaffleAllocationLimit: 20 },
      { size: 'Standard', price: 19, maxPerEmail: 1, maxPerCart: 2, maxRaffleAllocationLimit: 0 },
    ],
  };
  const raffle = resolveCategoryLimits(dup, dup.priceCategories[0]);
  assert.equal(raffle.maxPerEmail, 10);
  assert.equal(raffle.maxPerCart, 10);
  assert.equal(raffle.maxRaffleAllocationLimit, 20);

  const fcfs = resolveCategoryLimits(dup, dup.priceCategories[1]);
  assert.equal(fcfs.maxPerEmail, 1);
  assert.equal(fcfs.maxPerCart, 2);
  assert.equal(fcfs.maxRaffleAllocationLimit, 0);
});

test('resolveCategoryLimits: product-level fallback when the variant omits limits', () => {
  const product = { totalInventory: 50, maxPerEmail: 2, maxPerCart: 4, maxRaffleAllocationLimit: 25, priceCategories: [{ size: 'Small', price: 10 }] };
  const limits = resolveCategoryLimits(product, product.priceCategories[0]);
  assert.equal(limits.maxPerEmail, 2);
  assert.equal(limits.maxPerCart, 4);
  assert.equal(limits.maxRaffleAllocationLimit, 25);
  assert.equal(limits.inventory, 50);
});

test('shared inventory: normalizeInventorySyncSlug produces a stable token', () => {
  assert.equal(normalizeInventorySyncSlug('  Black Tee / M  '), 'black-tee-m');
  assert.equal(normalizeInventorySyncSlug('SAME_SLUG'), 'same-slug');
  assert.equal(normalizeInventorySyncSlug(''), '');
  assert.equal(normalizeInventorySyncSlug(null), '');
});

test('shared inventory: resolveInventorySyncSlug finds a size’s slug', () => {
  const product = {
    checkoutMode: 'RAFFLE',
    priceCategories: [
      { size: 'Standard', price: 95, inventorySyncSlug: 'black-tee' },
      { size: 'Limited', price: 150 },
    ],
  };
  assert.equal(resolveInventorySyncSlug(product, 'Standard'), 'black-tee');
  assert.equal(resolveInventorySyncSlug(product, 'Limited'), '');
  assert.equal(resolveInventorySyncSlug(product, 'Missing'), '');
  assert.equal(resolveInventorySyncSlug(product, ''), '');
});

test('shared inventory: sharedInventoryField uses the shared: prefix', () => {
  assert.equal(sharedInventoryField('black-tee'), 'shared:black-tee');
  assert.equal(sharedInventoryField('Black Tee!'), 'shared:black-tee');
  assert.equal(sharedInventoryField(''), '');
});

test('shared inventory: isSyncedSourceReleased only when another LIVE product owns the slug', () => {
  const synced = {
    id: 'p-child',
    isUpcoming: true, // parent container is unreleased
    priceCategories: [{ size: 'Standard', price: 95, inventorySyncSlug: 'black-tee' }],
  };

  // Source is in the same catalog, live (released) and owns the slug.
  const liveSource = {
    id: 'p-source',
    isActive: true,
    isArchived: false,
    isUpcoming: false,
    priceCategories: [{ size: 'Standard', price: 95, inventorySyncSlug: 'black-tee' }],
  };
  assert.equal(isSyncedSourceReleased(synced, 'Standard', [synced, liveSource]), true);

  // Source is archived → not released.
  const archivedSource = { ...liveSource, isArchived: true };
  assert.equal(isSyncedSourceReleased(synced, 'Standard', [synced, archivedSource]), false);

  // Source is itself upcoming → not released.
  const upcomingSource = { ...liveSource, isUpcoming: true };
  assert.equal(isSyncedSourceReleased(synced, 'Standard', [synced, upcomingSource]), false);

  // No other product owns the slug → not released.
  assert.equal(isSyncedSourceReleased(synced, 'Standard', [synced]), false);

  // A size without a slug never reports a released source.
  assert.equal(isSyncedSourceReleased({ id: 'x', priceCategories: [{ size: 'A' }] }, 'A', [liveSource]), false);
});

test('shared inventory: category/product slug matchers are case-insensitive + trimmed', () => {
  const cat = { size: 'Standard', inventorySyncSlug: '  Black Tee ' };
  assert.equal(categoryMatchesInventorySyncSlug(cat, 'BLACK-TEE'), true);
  assert.equal(categoryMatchesInventorySyncSlug(cat, 'black tee'), true);
  assert.equal(categoryMatchesInventorySyncSlug({ size: 'Standard', inventoryPoolId: 'black-tee' }, 'Black Tee'), true);
  assert.equal(categoryMatchesInventorySyncSlug({ size: 'Standard' }, 'black-tee'), false);

  const product = { id: 'p1', slug: '  Black Tee  ' };
  assert.equal(productMatchesInventorySyncSlug(product, 'BLACK-TEE'), true);
  assert.equal(productMatchesInventorySyncSlug(product, 'p1'), true);
  assert.equal(productMatchesInventorySyncSlug({ id: 'p2', slug: 'other' }, 'black-tee'), false);
});

test('shared inventory: findInventorySyncSource finds a sibling variant in the active editor', () => {
  const current = {
    id: 'p',
    slug: 'p',
    priceCategories: [
      { size: 'Standard', price: 95, inventorySyncSlug: 'black-tee' },
      { size: 'Limited', price: 150 },
    ],
  };
  const found = findInventorySyncSource('black-tee', [], current, 1);
  assert.ok(found);
  assert.equal(found.category.size, 'Standard');
  assert.equal(found.matchedBy, 'variant');
});

test('shared inventory: findInventorySyncSource matches a variant slug across the catalog', () => {
  const current = { id: 'p-edit', slug: 'editor', priceCategories: [{ size: 'Standard', price: 10 }] };
  const catalog = [
    { id: 'p-other', slug: 'other', priceCategories: [{ size: 'Standard', price: 95, inventorySyncSlug: 'Black Tee' }] },
  ];
  const found = findInventorySyncSource('black tee', catalog, current, 0);
  assert.ok(found);
  assert.equal(found.product.id, 'p-other');
  assert.equal(found.category.inventorySyncSlug, 'Black Tee');
  assert.equal(found.matchedBy, 'variant');
});

test('shared inventory: findInventorySyncSource matches a product slug across the catalog', () => {
  const current = { id: 'p-edit', slug: 'editor', priceCategories: [{ size: 'Limited', price: 10 }] };
  const catalog = [
    {
      id: 'p-source',
      slug: 'black-tee',
      priceCategories: [
        { size: 'Standard', price: 95 },
        { size: 'Limited', price: 150 },
      ],
    },
  ];
  const found = findInventorySyncSource('BLACK-TEE', catalog, current, 0);
  assert.ok(found);
  assert.equal(found.product.id, 'p-source');
  assert.equal(found.matchedBy, 'product');
  // Representative variant prefers the size being edited.
  assert.equal(found.category.size, 'Limited');
});

test('shared inventory: findInventorySyncSource returns null for a brand-new slug', () => {
  assert.equal(findInventorySyncSource('brand-new', [{ id: 'p', slug: 'x', priceCategories: [{ size: 'S' }] }], null, null), null);
});

test('shared inventory: isSyncedSourceReleased also accepts a product-slug source', () => {
  const synced = {
    id: 'p-child',
    isUpcoming: true,
    priceCategories: [{ size: 'Standard', price: 95, inventorySyncSlug: 'black-tee' }],
  };
  const liveSource = {
    id: 'p-source',
    slug: 'black-tee',
    isActive: true,
    isArchived: false,
    isUpcoming: false,
    priceCategories: [{ size: 'Standard', price: 95 }],
  };
  assert.equal(isSyncedSourceReleased(synced, 'Standard', [synced, liveSource]), true);
});
