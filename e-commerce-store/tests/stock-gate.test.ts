import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLiveStock, rebaseLiveStock } from '../lib/stock-gate.ts';

const product = {
  id: 'p1',
  priceCategories: [
    { size: '50ml', liveStock: 3, sharedPool: false },
    { size: 'Sample', liveStock: 0, sharedPool: false },
    { size: 'pooled', liveStock: null, sharedPool: true },
    { size: 'legacy' }, // loaded from the KV fallback: no liveStock at all
  ],
};

test('reads the authoritative count, matching size case-insensitively', () => {
  assert.deepEqual(readLiveStock(product, '50ml'), { ok: true, stock: 3 });
  assert.deepEqual(readLiveStock(product, 'sample'), { ok: true, stock: 0 });
});

test('fails closed on everything it cannot trust', () => {
  assert.deepEqual(readLiveStock(product, 'pooled'), { ok: false, reason: 'shared_pool' });
  assert.deepEqual(readLiveStock(product, 'legacy'), { ok: false, reason: 'unknown' });
  assert.deepEqual(readLiveStock(product, 'nope'), { ok: false, reason: 'unknown' });
  assert.deepEqual(readLiveStock({}, '50ml'), { ok: false, reason: 'unknown' });
});

test('rebase overwrites a drifted KV count with the truth (Postgres primary)', () => {
  const prev = process.env.USE_POSTGRES_PRIMARY;
  process.env.USE_POSTGRES_PRIMARY = 'true';
  try {
    const drifted = { inventoryRemaining: 99 };
    assert.equal(rebaseLiveStock(drifted, product, '50ml', 'test'), 3);
    assert.equal(drifted.inventoryRemaining, 3);

    // A drifted mirror claiming stock for a pooled size must NOT be believed.
    const pooled = { inventoryRemaining: 7 };
    assert.equal(rebaseLiveStock(pooled, product, 'pooled', 'test'), 0);
    assert.equal(pooled.inventoryRemaining, 0);
  } finally {
    if (prev === undefined) delete process.env.USE_POSTGRES_PRIMARY; else process.env.USE_POSTGRES_PRIMARY = prev;
  }
});

test('rebase leaves the KV count alone in legacy (non-Postgres) mode', () => {
  const prev = process.env.USE_POSTGRES_PRIMARY;
  delete process.env.USE_POSTGRES_PRIMARY;
  try {
    const kv = { inventoryRemaining: 5 };
    assert.equal(rebaseLiveStock(kv, product, '50ml', 'test'), 5);
    assert.equal(kv.inventoryRemaining, 5);
  } finally {
    if (prev !== undefined) process.env.USE_POSTGRES_PRIMARY = prev;
  }
});
