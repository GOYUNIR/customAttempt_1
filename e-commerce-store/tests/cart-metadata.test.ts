import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCartMetadata, decodeCartMetadata, CART_MAX_KEYS } from '../lib/cart-metadata.ts';

test('a cart round-trips through Stripe metadata exactly', () => {
  const lines = [
    { productId: 'prod_a', size: 'One Size', quantity: 2, unitCents: 1900 },
    { productId: 'prod_b', size: '50ml, "limited"', quantity: 1, unitCents: 16900 },
  ];
  const md = encodeCartMetadata(lines)!;
  for (const v of Object.values(md)) assert.ok(v.length <= 500, 'Stripe caps each value at 500 characters');
  assert.deepEqual(decodeCartMetadata(md), lines);
});

test('a large cart is split across keys, every value under Stripe\'s limit', () => {
  const lines = Array.from({ length: 50 }, (_, i) => ({ productId: 'prod_' + 'x'.repeat(20) + i, size: 'Size ' + i, quantity: 1, unitCents: 1000 + i }));
  const md = encodeCartMetadata(lines)!;
  assert.ok(Number(md.cart_parts) > 1);
  for (const v of Object.values(md)) assert.ok(v.length <= 500);
  assert.deepEqual(decodeCartMetadata(md), lines);
});

test('too big for Stripe metadata is refused up front, not truncated', () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ productId: 'prod_' + 'y'.repeat(30) + i, size: 'S' + i, quantity: 1, unitCents: 1 }));
  assert.equal(encodeCartMetadata(lines), null);
  assert.ok(CART_MAX_KEYS <= 49, 'leaves room for the other metadata keys (Stripe allows 50)');
});

test('missing or damaged parts decode to null (the webhook then records the payment loudly, never silently)', () => {
  const md = encodeCartMetadata([{ productId: 'p', size: 's', quantity: 1, unitCents: 100 }])!;
  assert.equal(decodeCartMetadata({}), null);
  assert.equal(decodeCartMetadata({ ...md, cart_0: '[[' }), null);
  assert.equal(decodeCartMetadata({ cart_parts: '2', cart_0: md.cart_0 }), null);
});
