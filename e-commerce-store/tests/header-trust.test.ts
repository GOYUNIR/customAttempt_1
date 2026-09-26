import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRequestHost, requestOrigin, clientIpFromHeaders, trustForwardedHost } from '../lib/edge-router.ts';

// HEADER TRUST (hardened 2026-09-26). Each case here was a real, client-settable
// header that decided something on production: see TENANCY.md "HARDENING".

test('SPOOF GUARD: the host comes from Host, never a client x-forwarded-host', () => {
  // Proven on production: shop.goyunir.com/admin + x-forwarded-host admin.* was
  // routed as the admin portal (307 to its login) instead of 404.
  assert.equal(resolveRequestHost({ host: 'shop.example.com', xForwardedHost: 'admin.example.com' }, '', false), 'shop.example.com');
  assert.equal(resolveRequestHost({ host: 'Shop.Example.com:443' }, '', false), 'shop.example.com');
  // Behind a declared trusted proxy, the forwarded host is used.
  assert.equal(resolveRequestHost({ host: 'internal:8080', xForwardedHost: 'shop.example.com, x' }, '', true), 'shop.example.com');
});

test('SPOOF GUARD: Stripe/email origins come from Host, keep the port, pick the scheme safely', () => {
  assert.equal(requestOrigin({ host: 'shop.example.com', xForwardedHost: 'evil.example', xForwardedProto: 'http' }, 'x', false), 'https://shop.example.com');
  assert.equal(requestOrigin({ host: 'localhost:3000' }, 'x', false), 'http://localhost:3000');
  assert.equal(requestOrigin({ host: 'internal', xForwardedHost: 'shop.example.com', xForwardedProto: 'https' }, 'x', true), 'https://shop.example.com');
  assert.equal(requestOrigin({ host: 'shop.example.com', xForwardedProto: 'javascript' }, 'x', true), 'https://shop.example.com');
});

test('SPOOF GUARD: the rate-limit IP is cf-connecting-ip, not a client x-forwarded-for', () => {
  // Proven on production: rotating X-Forwarded-For never hit merchant signup's
  // 5/hour limit; plain requests got 429 on the 6th.
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  assert.equal(clientIpFromHeaders(h({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.1' }), false), '198.51.100.7');
  assert.equal(clientIpFromHeaders(h({ 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '203.0.113.2' }), false), 'unknown');
  assert.equal(clientIpFromHeaders(h({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }), true), '203.0.113.1');
});

test('forwarded headers are off unless explicitly enabled', () => {
  assert.equal(trustForwardedHost({}), false);
  assert.equal(trustForwardedHost({ TRUST_FORWARDED_HOST: 'TRUE' }), true);
  assert.equal(trustForwardedHost({ TRUST_FORWARDED_HOST: '1' }), false);
});

test('no dynamic route under app/admin (the layout trusts x-pathname; middleware skips *.json/*.css paths)', () => {
  // If this fails: a dynamic admin segment could match a path the middleware
  // matcher skips, reaching app/admin/layout.tsx with a CLIENT-supplied
  // x-pathname that names an auth-exempt path. Re-check the layout first.
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? [p, ...walk(p)] : [];
  });
  const dynamic = walk(join(import.meta.dirname, '..', 'app', 'admin')).filter((d) => /[\/]\[/.test(d));
  assert.deepEqual(dynamic, []);
});
