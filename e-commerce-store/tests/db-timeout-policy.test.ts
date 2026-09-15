import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_INTERACTIVE_TIMEOUT_MS,
  isRetryableMethod,
  isRetryableStatus,
  resolveTimeoutMs,
  retryDelayMs,
  shouldRetry,
  type DbMethod,
} from '../lib/db-timeout-policy.ts';

test('resolveTimeoutMs: tier defaults — interactive fails fast, background is patient', () => {
  assert.equal(resolveTimeoutMs('interactive', {}), DEFAULT_INTERACTIVE_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs('background', {}), DEFAULT_BACKGROUND_TIMEOUT_MS);
  assert.ok(DEFAULT_INTERACTIVE_TIMEOUT_MS < DEFAULT_BACKGROUND_TIMEOUT_MS);
});

test('resolveTimeoutMs: tier-specific env beats the shared override', () => {
  const env = { SUPABASE_TIMEOUT_MS: '9000', SUPABASE_TIMEOUT_MS_INTERACTIVE: '1500' };
  assert.equal(resolveTimeoutMs('interactive', env), 1500);
  assert.equal(resolveTimeoutMs('background', env), 9000);
});

test('resolveTimeoutMs: clamps absurd values instead of trusting them', () => {
  assert.equal(resolveTimeoutMs('interactive', { SUPABASE_TIMEOUT_MS: '0' }), DEFAULT_INTERACTIVE_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs('interactive', { SUPABASE_TIMEOUT_MS: '-5' }), DEFAULT_INTERACTIVE_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs('interactive', { SUPABASE_TIMEOUT_MS: '10' }), 250);
  assert.equal(resolveTimeoutMs('interactive', { SUPABASE_TIMEOUT_MS: '999999' }), 60_000);
  assert.equal(resolveTimeoutMs('interactive', { SUPABASE_TIMEOUT_MS: 'abc' }), DEFAULT_INTERACTIVE_TIMEOUT_MS);
});

test('SAFETY: writes are NEVER retryable — a retried POST can duplicate a row', () => {
  assert.equal(isRetryableMethod('GET'), true);
  for (const m of ['POST', 'PATCH', 'DELETE'] as DbMethod[]) {
    assert.equal(isRetryableMethod(m), false, `${m} must not be retryable`);
  }
});

test('SAFETY: shouldRetry refuses writes even on a transient 503 or network error', () => {
  for (const m of ['POST', 'PATCH', 'DELETE'] as DbMethod[]) {
    assert.equal(shouldRetry({ method: m, attempt: 1, status: 503 }), false);
    assert.equal(shouldRetry({ method: m, attempt: 1, networkError: true }), false);
  }
});

test('isRetryableStatus: 5xx / 408 / 429 yes; ordinary 4xx no', () => {
  for (const s of [500, 502, 503, 504, 408, 429]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404, 409, 422]) assert.equal(isRetryableStatus(s), false, String(s));
});

test('shouldRetry: GET retries on transient failure, stops at the attempt cap', () => {
  assert.equal(shouldRetry({ method: 'GET', attempt: 1, status: 503 }), true);
  assert.equal(shouldRetry({ method: 'GET', attempt: 2, networkError: true }), true);
  assert.equal(shouldRetry({ method: 'GET', attempt: 3, status: 503 }), false, 'must stop at MAX_DB_ATTEMPTS');
});

test('shouldRetry: a successful or client-error GET is not retried', () => {
  assert.equal(shouldRetry({ method: 'GET', attempt: 1, status: 200 }), false);
  assert.equal(shouldRetry({ method: 'GET', attempt: 1, status: 404 }), false);
  assert.equal(shouldRetry({ method: 'GET', attempt: 1 }), false);
});

test('retryDelayMs: grows and is bounded', () => {
  assert.equal(retryDelayMs(1), 100);
  assert.equal(retryDelayMs(2), 300);
  assert.equal(retryDelayMs(3), 900);
  assert.ok(retryDelayMs(99) <= 100 * Math.pow(3, 4));
});
