import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrderRef, formatOrderRef } from '../lib/order-ref';

test('buildOrderRef uses the GY prefix and preserves a stable reference', () => {
  const first = buildOrderRef('buyer@example.com', 'prod-1', 'Standard');
  const second = buildOrderRef('buyer@example.com', 'prod-1', 'Standard');

  assert.match(first, /^GY-[A-Z0-9]+$/);
  assert.equal(first, second);
  assert.equal(formatOrderRef(first), first);
});
