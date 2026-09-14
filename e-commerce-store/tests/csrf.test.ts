import assert from 'node:assert/strict';
import test from 'node:test';
import { isCsrfBlocked } from '../lib/csrf.ts';

const base = {
  method: 'POST',
  pathname: '/api/account/change-password',
  cookieHeader: 'goyunir_session=abc123',
  origin: 'https://store.example',
  referer: null as string | null,
  requestHost: 'store.example',
};

test('safe methods are never blocked, even cross-site with a cookie', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(isCsrfBlocked({ ...base, method, origin: 'https://evil.example' }), false);
  }
});

test('no auth cookie present → never blocked (nothing to forge)', () => {
  assert.equal(isCsrfBlocked({ ...base, cookieHeader: '', origin: 'https://evil.example' }), false);
  assert.equal(isCsrfBlocked({ ...base, cookieHeader: 'unrelated=1', origin: 'https://evil.example' }), false);
});

test('cookie + same-origin Origin header → allowed', () => {
  assert.equal(isCsrfBlocked(base), false);
});

test('cookie + mismatched Origin host → blocked', () => {
  assert.equal(isCsrfBlocked({ ...base, origin: 'https://evil.example' }), true);
});

test('cookie + no Origin, but matching Referer → allowed', () => {
  assert.equal(
    isCsrfBlocked({ ...base, origin: null, referer: 'https://store.example/account' }),
    false,
  );
});

test('cookie + mismatched Referer host → blocked', () => {
  assert.equal(
    isCsrfBlocked({ ...base, origin: null, referer: 'https://evil.example/phish' }),
    true,
  );
});

test('cookie-bearing write with neither Origin nor Referer → blocked', () => {
  assert.equal(isCsrfBlocked({ ...base, origin: null, referer: null }), true);
});

test('cookie-bearing write with an unparsable Origin → blocked', () => {
  assert.equal(isCsrfBlocked({ ...base, origin: 'not-a-url' }), true);
});

test('recognizes every first-party auth cookie, not just the customer session', () => {
  assert.equal(
    isCsrfBlocked({ ...base, cookieHeader: 'goyunir_admin_device=xyz', origin: 'https://evil.example' }),
    true,
  );
  assert.equal(
    isCsrfBlocked({ ...base, cookieHeader: 'goyunir_admin_auth=xyz', origin: 'https://evil.example' }),
    true,
  );
});

test('Stripe webhook path is exempt even with a (spoofed) cookie and cross-site origin', () => {
  assert.equal(
    isCsrfBlocked({
      ...base,
      pathname: '/api/stripe/webhook',
      origin: 'https://evil.example',
    }),
    false,
  );
});

test('cron paths are exempt (server-to-server, secret-authenticated, no Origin sent)', () => {
  assert.equal(
    isCsrfBlocked({ ...base, pathname: '/api/cron/auto-draw', origin: null, referer: null }),
    false,
  );
  assert.equal(
    isCsrfBlocked({ ...base, pathname: '/api/checkout/cron-draw', origin: null, referer: null }),
    false,
  );
});

test('a legitimate same-origin admin write is never blocked', () => {
  assert.equal(
    isCsrfBlocked({
      method: 'POST',
      pathname: '/api/admin/wipe',
      cookieHeader: 'goyunir_admin_device=abc',
      origin: 'https://admin.example',
      referer: null,
      requestHost: 'admin.example',
    }),
    false,
  );
});
