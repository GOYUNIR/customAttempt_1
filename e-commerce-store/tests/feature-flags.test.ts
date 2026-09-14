import assert from 'node:assert/strict';
import test from 'node:test';
import { isPostgresPrimaryEnabled } from '../lib/feature-flags.ts';

test('defaults to false when unset', () => {
  assert.equal(isPostgresPrimaryEnabled({}), false);
});

test('is false for any value other than the literal string "true"', () => {
  assert.equal(isPostgresPrimaryEnabled({ USE_POSTGRES_PRIMARY: '1' }), false);
  assert.equal(isPostgresPrimaryEnabled({ USE_POSTGRES_PRIMARY: 'yes' }), false);
  assert.equal(isPostgresPrimaryEnabled({ USE_POSTGRES_PRIMARY: 'TRUE ' }), true); // trimmed + case-insensitive
  assert.equal(isPostgresPrimaryEnabled({ USE_POSTGRES_PRIMARY: 'false' }), false);
});

test('is true only for "true" (case/whitespace tolerant)', () => {
  assert.equal(isPostgresPrimaryEnabled({ USE_POSTGRES_PRIMARY: 'true' }), true);
  assert.equal(isPostgresPrimaryEnabled({ USE_POSTGRES_PRIMARY: '  true  ' }), true);
  assert.equal(isPostgresPrimaryEnabled({ USE_POSTGRES_PRIMARY: 'True' }), true);
});
