import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCronAuthorized, isPlatformScheduledInvocation } from '../lib/cron-auth.ts';

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

test('SPOOF GUARD: x-vercel-cron alone authorizes nothing (any client can send it)', () => {
  // Proven on production 2026-09-26: this header ran a cron route from curl.
  const r = req('https://store.example.com/api/checkout/cron-draw', { 'x-vercel-cron': '1' });
  assert.equal(isPlatformScheduledInvocation(r), false);
  assert.equal(isCronAuthorized(r, 's3cret'), false);
  // With the secret it still works, header or not.
  assert.equal(isCronAuthorized(req('https://store.example.com/api/checkout/cron-draw', { 'x-vercel-cron': '1', authorization: 'Bearer s3cret' }), 's3cret'), true);
});

test('a plain request is not a platform scheduled invocation', () => {
  assert.equal(isPlatformScheduledInvocation(req('https://store.example.com/cron')), false);
  assert.equal(isPlatformScheduledInvocation(req('https://store.example.com/cron', { 'x-vercel-cron': '0' })), false);
});

test('Authorization: Bearer with the secret is accepted', () => {
  assert.equal(isCronAuthorized(req('https://store.example.com/cron', { authorization: 'Bearer s3cret' }), 's3cret'), true);
  assert.equal(isCronAuthorized(req('https://store.example.com/cron', { authorization: 'Bearer wrong' }), 's3cret'), false);
});

test('legacy ?key= query parameter is accepted', () => {
  assert.equal(isCronAuthorized(req('https://store.example.com/cron?key=s3cret'), 's3cret'), true);
  assert.equal(isCronAuthorized(req('https://store.example.com/cron?key=wrong'), 's3cret'), false);
});

test('x-cron-secret header is accepted for schedulers without bearer control', () => {
  assert.equal(isCronAuthorized(req('https://store.example.com/cron', { 'x-cron-secret': 's3cret' }), 's3cret'), true);
  assert.equal(isCronAuthorized(req('https://store.example.com/cron', { 'x-cron-secret': 'wrong' }), 's3cret'), false);
});

test('no secret configured: closed by default, open only with openWhenNoSecret', () => {
  const r = req('https://store.example.com/cron');
  assert.equal(isCronAuthorized(r, ''), false);
  assert.equal(isCronAuthorized(r, '', { openWhenNoSecret: true }), true);
});
