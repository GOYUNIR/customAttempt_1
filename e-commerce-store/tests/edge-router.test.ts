import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHost, cookieDomainForPortal, corsOriginAllowed } from '../lib/edge-router.ts';

const ROOT = 'site.com';

test('classifyHost: no root domain configured → always storefront (today\'s behavior, unchanged)', () => {
  assert.equal(classifyHost('admin.site.com', undefined), 'storefront');
  assert.equal(classifyHost('sales.site.com', ''), 'storefront');
  assert.equal(classifyHost('localhost:3000', undefined), 'storefront');
});

test('classifyHost: the bare root domain is marketing', () => {
  assert.equal(classifyHost('site.com', ROOT), 'marketing');
});

test('classifyHost: admin. and app. both map to the admin portal (single-tenant, one admin app today)', () => {
  assert.equal(classifyHost('admin.site.com', ROOT), 'admin');
  assert.equal(classifyHost('app.site.com', ROOT), 'admin');
});

test('classifyHost: sales. maps to the sales portal', () => {
  assert.equal(classifyHost('sales.site.com', ROOT), 'sales');
});

test('classifyHost: an unrecognized subdomain or custom domain falls back to storefront', () => {
  assert.equal(classifyHost('mystore.site.com', ROOT), 'storefront');
  assert.equal(classifyHost('www.custom-merchant-domain.com', ROOT), 'storefront');
});

test('classifyHost: is case-insensitive and strips a port', () => {
  assert.equal(classifyHost('ADMIN.SITE.COM:443', ROOT), 'admin');
});

test('classifyHost: empty host is storefront, not a crash', () => {
  assert.equal(classifyHost('', ROOT), 'storefront');
});

test('cookieDomainForPortal: undefined when no root domain configured (host-only cookie, unchanged)', () => {
  assert.equal(cookieDomainForPortal('admin', undefined), undefined);
  assert.equal(cookieDomainForPortal('sales', ''), undefined);
});

test('cookieDomainForPortal: scopes admin/sales cookies to their own subdomain', () => {
  assert.equal(cookieDomainForPortal('admin', ROOT), 'admin.site.com');
  assert.equal(cookieDomainForPortal('sales', ROOT), 'sales.site.com');
});

test('cookieDomainForPortal: marketing/storefront are never domain-scoped', () => {
  assert.equal(cookieDomainForPortal('marketing', ROOT), undefined);
  assert.equal(cookieDomainForPortal('storefront', ROOT), undefined);
});

test('corsOriginAllowed: false with no root domain configured (falls back to same-origin logic elsewhere)', () => {
  assert.equal(corsOriginAllowed('https://sales.site.com', 'sales', undefined), false);
});

test('corsOriginAllowed: true when the Origin classifies to the same portal', () => {
  assert.equal(corsOriginAllowed('https://sales.site.com', 'sales', ROOT), true);
});

test('corsOriginAllowed: false when the Origin classifies to a different portal', () => {
  assert.equal(corsOriginAllowed('https://admin.site.com', 'sales', ROOT), false);
});

test('corsOriginAllowed: false for a null or unparsable Origin', () => {
  assert.equal(corsOriginAllowed(null, 'sales', ROOT), false);
  assert.equal(corsOriginAllowed('not-a-url', 'sales', ROOT), false);
});
