import assert from 'node:assert/strict';
import test from 'node:test';
import { productNameFromPoolKey, sizeFromPoolKey } from '../lib/draw-keys.ts';

test('productNameFromPoolKey handles plain and multi-word names', () => {
  assert.equal(productNameFromPoolKey('entries:pool:Elysian White — Launch Draw:Standard'), 'Elysian White — Launch Draw');
  assert.equal(productNameFromPoolKey('entries:pool:Signature Heavyweight Tee — Vol. 1:Standard'), 'Signature Heavyweight Tee — Vol. 1');
  // Multi-word names with spaces survive; the FIRST colon after the namespace
  // is the name/size separator (matching sizeFromPoolKey).
  assert.equal(sizeFromPoolKey('entries:pool:Noir Citrus — Instant Drop:Full Bottle'), 'Full Bottle');
  assert.equal(productNameFromPoolKey('entries:pool:Noir Citrus — Instant Drop:Full Bottle'), 'Noir Citrus — Instant Drop');
  // Key with no size segment falls back to the pool-key default.
  assert.equal(productNameFromPoolKey('entries:pool:Solo'), 'Solo');
  assert.equal(sizeFromPoolKey('entries:pool:Solo'), 'Standard');
});
