import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHost, cookieDomainForPortal, corsOriginAllowed, isPortalPathAllowed, portalIsolationStatus } from '../lib/edge-router.ts';

const ROOT = 'site.com';

test('classifyHost: no root domain configured → always storefront (today\'s behavior, unchanged)', () => {
  assert.equal(classifyHost('admin.site.com', undefined), 'storefront');
  assert.equal(classifyHost('sales.site.com', ''), 'storefront');
  assert.equal(classifyHost('localhost:3000', undefined), 'storefront');
});

test('classifyHost: the bare root domain is marketing', () => {
  assert.equal(classifyHost('site.com', ROOT), 'marketing');
});

test('classifyHost: admin. and app. map to DISTINCT portals (same route tree, different required role)', () => {
  assert.equal(classifyHost('admin.site.com', ROOT), 'admin');
  assert.equal(classifyHost('app.site.com', ROOT), 'merchant');
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

test('cookieDomainForPortal: scopes admin/merchant/sales cookies to their own subdomain', () => {
  assert.equal(cookieDomainForPortal('admin', ROOT), 'admin.site.com');
  assert.equal(cookieDomainForPortal('merchant', ROOT), 'app.site.com');
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

test('isPortalPathAllowed: no root domain configured → always allowed (today\'s behavior, unchanged)', () => {
  assert.equal(isPortalPathAllowed('/admin', 'storefront', undefined), true);
  assert.equal(isPortalPathAllowed('/sales', 'storefront', undefined), true);
});

test('isPortalPathAllowed: /admin* is reachable from the admin and merchant portals, not sales/storefront/marketing', () => {
  assert.equal(isPortalPathAllowed('/admin', 'admin', ROOT), true);
  assert.equal(isPortalPathAllowed('/api/admin/users', 'merchant', ROOT), true);
  assert.equal(isPortalPathAllowed('/admin', 'sales', ROOT), false);
  assert.equal(isPortalPathAllowed('/admin', 'storefront', ROOT), false);
  assert.equal(isPortalPathAllowed('/admin', 'marketing', ROOT), false);
});

test('isPortalPathAllowed: /sales* is reachable from the sales and admin portals, not merchant/storefront', () => {
  assert.equal(isPortalPathAllowed('/sales', 'sales', ROOT), true);
  assert.equal(isPortalPathAllowed('/api/sales/quotes', 'admin', ROOT), true);
  assert.equal(isPortalPathAllowed('/sales', 'merchant', ROOT), false);
  assert.equal(isPortalPathAllowed('/sales', 'storefront', ROOT), false);
});

test('isPortalPathAllowed: every other path is always allowed regardless of portal', () => {
  assert.equal(isPortalPathAllowed('/catalog', 'storefront', ROOT), true);
  assert.equal(isPortalPathAllowed('/api/checkout/cart', 'merchant', ROOT), true);
});

// ── goyunir.com production-domain shape (not just the generic "site.com"
// example above) — pins the exact mapping this session's live deployment
// asks for: app./sales./admin. → their portals, the bare root and every
// wildcard tenant subdomain → storefront/marketing, never a portal. ────────
const PROD_ROOT = 'goyunir.com';

test('classifyHost (goyunir.com): app./sales./admin. map to their portals', () => {
  assert.equal(classifyHost('app.goyunir.com', PROD_ROOT), 'merchant');
  assert.equal(classifyHost('sales.goyunir.com', PROD_ROOT), 'sales');
  assert.equal(classifyHost('admin.goyunir.com', PROD_ROOT), 'admin');
});

test('classifyHost (goyunir.com): the bare root is marketing, any other subdomain is a tenant storefront', () => {
  assert.equal(classifyHost('goyunir.com', PROD_ROOT), 'marketing');
  assert.equal(classifyHost('acme-drops.goyunir.com', PROD_ROOT), 'storefront');
  assert.equal(classifyHost('my-raffle-store.goyunir.com', PROD_ROOT), 'storefront');
});

test('classifyHost (goyunir.com): a merchant custom domain (not *.goyunir.com at all) is also a storefront', () => {
  assert.equal(classifyHost('shop.some-merchant-brand.com', PROD_ROOT), 'storefront');
});

test('isPortalPathAllowed (goyunir.com): a wildcard tenant subdomain can never reach /admin or /sales', () => {
  assert.equal(isPortalPathAllowed('/admin', classifyHost('acme-drops.goyunir.com', PROD_ROOT), PROD_ROOT), false);
  assert.equal(isPortalPathAllowed('/sales', classifyHost('acme-drops.goyunir.com', PROD_ROOT), PROD_ROOT), false);
  assert.equal(isPortalPathAllowed('/[slug]', classifyHost('acme-drops.goyunir.com', PROD_ROOT), PROD_ROOT), true);
});

// ── Fail-closed portal isolation (Phase A2) ───────────────────────────────
// The whole point is that production can never SILENTLY run unisolated.

test('portalIsolationStatus: a configured root domain is active', () => {
  assert.equal(portalIsolationStatus({ PLATFORM_ROOT_DOMAIN: 'goyunir.com', NODE_ENV: 'production' }), 'active');
});

test('portalIsolationStatus: unset in production with no opt-out is MISCONFIGURED (fails closed)', () => {
  assert.equal(portalIsolationStatus({ NODE_ENV: 'production' }), 'misconfigured');
  assert.equal(portalIsolationStatus({ NODE_ENV: 'production', PLATFORM_ROOT_DOMAIN: '   ' }), 'misconfigured');
});

test('portalIsolationStatus: an explicit single-domain opt-out is respected in production', () => {
  assert.equal(
    portalIsolationStatus({ NODE_ENV: 'production', PLATFORM_SINGLE_DOMAIN_MODE: 'true' }),
    'single-domain',
  );
});

test('portalIsolationStatus: local dev without the var is fine, never misconfigured', () => {
  assert.equal(portalIsolationStatus({ NODE_ENV: 'development' }), 'single-domain');
  assert.equal(portalIsolationStatus({}), 'single-domain');
});
