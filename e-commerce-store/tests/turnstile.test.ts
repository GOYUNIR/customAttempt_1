import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyTurnstile } from '../lib/turnstile.ts';

// Against Cloudflare's REAL siteverify with its published TEST secrets
// (developers.cloudflare.com/turnstile/troubleshooting/testing): they always
// pass (hostname "example.com"), always fail, or report an already-spent token.
const PASS = '1x0000000000000000000000000000000AA';
const FAIL = '2x0000000000000000000000000000000AA';
const SPENT = '3x0000000000000000000000000000000AA';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const online = process.env.OFFLINE_TESTS !== '1';

test('a valid token from an expected host passes', { skip: !online }, async () => {
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: PASS, expectedHosts: ['example.com'], ip: '203.0.113.9' }), { ok: true });
});

test('a forged or expired token fails; a REPLAYED (spent) token fails', { skip: !online }, async () => {
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: FAIL, expectedHosts: ['example.com'] }), { ok: false, reason: 'rejected' });
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: SPENT, expectedHosts: ['example.com'] }), { ok: false, reason: 'rejected' });
});

test('a token solved on another hostname is refused', { skip: !online }, async () => {
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: PASS, expectedHosts: ['goyunir.com'] }), { ok: false, reason: 'hostname' });
});

test('fails CLOSED: no token, no secret, network down, Cloudflare error, stale', async () => {
  assert.equal((await verifyTurnstile({ token: '', secret: PASS, expectedHosts: ['example.com'] })).ok, false);
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: '', expectedHosts: ['example.com'] }), { ok: false, reason: 'unavailable' });
  const down = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: PASS, expectedHosts: ['example.com'], fetchImpl: down }), { ok: false, reason: 'unavailable' });
  const err500 = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: PASS, expectedHosts: ['example.com'], fetchImpl: err500 }), { ok: false, reason: 'unavailable' });
  const old = (async () => Response.json({ success: true, hostname: 'example.com', challenge_ts: '2020-01-01T00:00:00Z' })) as unknown as typeof fetch;
  assert.deepEqual(await verifyTurnstile({ token: TOKEN, secret: PASS, expectedHosts: ['example.com'], fetchImpl: old }), { ok: false, reason: 'stale' });
});
