import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheKeyForSite, normalizeHostname, resolveSiteKey } from '../../shared/hostname.ts';

test('normalizeHostname strips ports, trailing dots and case', () => {
  assert.equal(normalizeHostname('Demo.YourPlatform.com:8443'), 'demo.yourplatform.com');
  assert.equal(normalizeHostname('shop.acme.com.'), 'shop.acme.com');
});

test('resolveSiteKey: platform subdomains resolve to their subdomain key', () => {
  assert.deepEqual(resolveSiteKey('demo.yourplatform.com', 'yourplatform.com'), {
    hostname: 'demo.yourplatform.com',
    kind: 'platform',
    siteKey: 'demo',
    subdomain: 'demo',
  });
  assert.deepEqual(resolveSiteKey('my-shop.yourplatform.com', 'yourplatform.com'), {
    hostname: 'my-shop.yourplatform.com',
    kind: 'platform',
    siteKey: 'my-shop',
    subdomain: 'my-shop',
  });
});

test('resolveSiteKey: platform apex, malformed and reserved hosts are rejected', () => {
  assert.equal(resolveSiteKey('yourplatform.com', 'yourplatform.com'), null);
  assert.equal(resolveSiteKey('-bad.yourplatform.com', 'yourplatform.com'), null);
  assert.equal(resolveSiteKey('a_b.yourplatform.com', 'yourplatform.com'), null);
});

test('resolveSiteKey: trailing-dot FQDN normalizes to the same tenant', () => {
  assert.deepEqual(resolveSiteKey('demo.yourplatform.com.', 'yourplatform.com'), {
    hostname: 'demo.yourplatform.com',
    kind: 'platform',
    siteKey: 'demo',
    subdomain: 'demo',
  });
});

test('resolveSiteKey: custom domains (www is an alias of the bare domain)', () => {
  assert.deepEqual(resolveSiteKey('www.shop.acme.com', 'yourplatform.com'), {
    hostname: 'www.shop.acme.com',
    kind: 'custom',
    siteKey: 'shop.acme.com',
    subdomain: null,
  });
  assert.deepEqual(resolveSiteKey('shop.acme.com', 'yourplatform.com'), {
    hostname: 'shop.acme.com',
    kind: 'custom',
    siteKey: 'shop.acme.com',
    subdomain: null,
  });
});

test('resolveSiteKey: localhost and raw IPs are rejected', () => {
  assert.equal(resolveSiteKey('localhost', 'yourplatform.com'), null);
  assert.equal(resolveSiteKey('localhost:3000', 'yourplatform.com'), null);
  assert.equal(resolveSiteKey('127.0.0.1', 'yourplatform.com'), null);
});

test('cacheKeyForSite versions the key (cache-version self-invalidation)', () => {
  assert.equal(cacheKeyForSite('demo', 1), 'site_cache:v1:demo');
  assert.equal(cacheKeyForSite('shop.acme.com', 2), 'site_cache:v2:shop.acme.com');
});
