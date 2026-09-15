import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundIdempotencyKey,
  idempotencyDigest,
  STRIPE_IDEMPOTENCY_KEY_MAX,
} from '../lib/idempotency-key.ts';

const LONG_EMAIL = `${'a'.repeat(200)}@example.com`;
const UUID = '3f1c9a0e-7d2b-4c65-9f83-2b7d4e5a6c10';

test('a key within the cap is returned byte-for-byte unchanged', () => {
  const key = `raffle-draw:${UUID}:entry-1`;
  assert.equal(boundIdempotencyKey(key), key);
});

test('a key exactly at the cap is untouched; one char over is bounded', () => {
  const exact = 'k'.repeat(STRIPE_IDEMPOTENCY_KEY_MAX);
  assert.equal(boundIdempotencyKey(exact), exact);
  const over = 'k'.repeat(STRIPE_IDEMPOTENCY_KEY_MAX + 1);
  assert.notEqual(boundIdempotencyKey(over), over);
  assert.equal(boundIdempotencyKey(over).length, STRIPE_IDEMPOTENCY_KEY_MAX);
});

test('the real over-length case from the money path is brought under the cap', () => {
  // The exact shape that live Stripe rejected at 272 chars.
  const key = `autodraw:${UUID}:MEDIUM:0:${LONG_EMAIL}`;
  assert.ok(key.length > STRIPE_IDEMPOTENCY_KEY_MAX, 'precondition: this key is over-length');
  const bounded = boundIdempotencyKey(key);
  assert.ok(bounded.length <= STRIPE_IDEMPOTENCY_KEY_MAX);
});

test('DETERMINISM: bounding is stable across calls — a retry produces the same key', () => {
  const key = `autodraw:${UUID}:MEDIUM:0:${LONG_EMAIL}`;
  const first = boundIdempotencyKey(key);
  for (let i = 0; i < 25; i++) {
    assert.equal(boundIdempotencyKey(key), first, 'bounding must never vary — idempotency depends on it');
  }
});

test('DISTINCTNESS: two different over-length keys do not collapse to the same key', () => {
  // Same length, differing only in the final character of the email — the
  // worst case for a naive truncate-only approach, which would merge them
  // and charge only one of two different customers.
  const a = boundIdempotencyKey(`autodraw:${UUID}:MEDIUM:0:${'a'.repeat(240)}1@example.com`);
  const b = boundIdempotencyKey(`autodraw:${UUID}:MEDIUM:0:${'a'.repeat(240)}2@example.com`);
  assert.notEqual(a, b);
});

test('DISTINCTNESS: differing only in the draw-cycle discriminator stays distinct', () => {
  const cycle0 = boundIdempotencyKey(`autodraw:${UUID}:MEDIUM:0:${LONG_EMAIL}`);
  const cycle1 = boundIdempotencyKey(`autodraw:${UUID}:MEDIUM:1:${LONG_EMAIL}`);
  assert.notEqual(cycle0, cycle1, 'the next raffle cycle must be able to charge again');
});

test('digest is deterministic, and differs for inputs sharing a long prefix', () => {
  assert.equal(idempotencyDigest('abc'), idempotencyDigest('abc'));
  const p = 'x'.repeat(500);
  assert.notEqual(idempotencyDigest(`${p}1`), idempotencyDigest(`${p}2`));
});

test('digest has no collisions across a large sweep of realistic key inputs', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20000; i++) {
    seen.add(idempotencyDigest(`autodraw:${UUID}:MEDIUM:0:customer${i}@example.com`));
  }
  assert.equal(seen.size, 20000, 'digest collided within 20k realistic inputs');
});

test('bounded output contains no characters Stripe would reject', () => {
  const bounded = boundIdempotencyKey(`autodraw:${UUID}:MEDIUM:0:${LONG_EMAIL}`);
  assert.match(bounded, /^[\x20-\x7e]+$/, 'must stay printable ASCII');
});
