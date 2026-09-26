import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStorefrontHost, isReservedStoreSlug, parseLegacyHosts } from '../lib/storefront-host.ts';

const ROOT = 'example.com';
const LEGACY = parseLegacyHosts('shop,www,api', ROOT);
const at = (host: string, legacyHosts = LEGACY, rootDomain: string | undefined = ROOT) =>
  classifyStorefrontHost({ host, rootDomain, legacyHosts });

test('the legacy store keeps its hosts, whatever the port or case', () => {
  assert.deepEqual(at('shop.example.com'), { kind: 'default' });
  assert.deepEqual(at('WWW.Example.com:443'), { kind: 'default' });
  assert.deepEqual(at('api.example.com.'), { kind: 'default' });
});

test('LIVE-ADDRESS GUARD: a legacy host wins over any tenant slug, and its label is reserved', () => {
  // Even if a tenant somehow had slug "shop", shop.<root> is the legacy store.
  assert.deepEqual(at('shop.example.com'), { kind: 'default' });
  assert.equal(isReservedStoreSlug('shop', LEGACY, ROOT), true);
  // A custom legacy label (not in the built-in list) is reserved too.
  const custom = parseLegacyHosts('boutique', ROOT);
  assert.equal(isReservedStoreSlug('boutique', custom, ROOT), true);
  assert.equal(isReservedStoreSlug('Boutique', custom, ROOT), true);
});

test('a merchant subdomain is a slug claim; portals and the root are not stores', () => {
  assert.deepEqual(at('test4.example.com'), { kind: 'slug', slug: 'test4' });
  assert.deepEqual(at('admin.example.com'), { kind: 'portal' });
  assert.deepEqual(at('app.example.com'), { kind: 'portal' });
  assert.deepEqual(at('sales.example.com'), { kind: 'portal' });
  assert.deepEqual(at('example.com'), { kind: 'marketing' });
});

test('FAIL CLOSED: reserved labels, nested and malformed subdomains serve nothing', () => {
  assert.deepEqual(at('media.example.com'), { kind: 'not_found' });
  assert.deepEqual(at('default.example.com'), { kind: 'not_found' });
  assert.deepEqual(at('a.b.example.com'), { kind: 'not_found' });
  assert.deepEqual(at('-bad.example.com'), { kind: 'not_found' });
  assert.deepEqual(at(''), { kind: 'not_found' });
});

test('SAFE ROLLOUT: with the legacy-host setting missing, unknown subdomains stay the default store', () => {
  // A setting that never reached production must not 404 the live store.
  assert.equal(parseLegacyHosts('', ROOT), null);
  assert.equal(parseLegacyHosts(undefined, ROOT), null);
  assert.deepEqual(at('shop.example.com', null), { kind: 'default' });
  assert.deepEqual(at('anything.example.com', null), { kind: 'default' });
  // ...but portals and marketing are still themselves.
  assert.deepEqual(at('admin.example.com', null), { kind: 'portal' });
  assert.deepEqual(at('example.com', null), { kind: 'marketing' });
});

test('no root domain configured: every host is the default store (single-domain deployment)', () => {
  assert.deepEqual(at('anything.example.org', LEGACY, ''), { kind: 'default' });
  assert.deepEqual(at('localhost:3000', null, ''), { kind: 'default' });
});

test('outside the root: a custom-domain claim, except local development', () => {
  assert.deepEqual(at('brand-store.com'), { kind: 'custom', host: 'brand-store.com' });
  assert.deepEqual(at('Shop.Brand-Store.com:8443'), { kind: 'custom', host: 'shop.brand-store.com' });
  assert.deepEqual(at('localhost:3000'), { kind: 'default' });
  assert.deepEqual(at('127.0.0.1'), { kind: 'default' });
  assert.deepEqual(at('not a host'), { kind: 'not_found' });
});

test('reserved slugs: platform labels, empty, and ordinary slugs allowed', () => {
  for (const s of ['admin', 'app', 'sales', 'www', 'api', 'media', 'default', '']) {
    assert.equal(isReservedStoreSlug(s, LEGACY, ROOT), true, s);
  }
  for (const s of ['test4', 'goyunir-test-1', 'atelier-nord']) {
    assert.equal(isReservedStoreSlug(s, LEGACY, ROOT), false, s);
  }
});

import { withNeutralHero } from '../lib/storefront-host.ts';

test('BRAND GUARD: a new store gets its own name, never the default store\'s hero copy', () => {
  const out = withNeutralHero({}, 'Atelier Nord').heroContent;
  assert.equal(out.headline, 'Atelier Nord');
  // Empty fields fall back to the template (the default store's copy), so the
  // unset ones are hidden rather than blanked.
  assert.equal(out.showEyebrow, false);
  assert.equal(out.showBody, false);
  assert.equal(out.showStory, false);
  // Not "legacy" hero content (which mergePublicConfig swaps for the defaults).
  assert.equal(typeof out.storyBody, 'string');
});

test('what the merchant set is kept', () => {
  const stored = { heroContent: { headline: 'Our drop', eyebrow: 'Oslo', body: 'Made here.', storyHeadline: 'Story', storyBody: 'Why.' }, other: 1 };
  const out = withNeutralHero(stored, 'Atelier Nord');
  assert.equal(out.other, 1);
  assert.deepEqual(out.heroContent, stored.heroContent);
});

import { merchantHostAllowsPath, APP_TOP_LEVEL_ROUTES } from '../lib/storefront-host.ts';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

test('LEAK GUARD: a merchant address serves only tenant-aware paths', () => {
  for (const p of ['/', '/catalog', '/catalog/', '/api/store', '/api/catalog/status', '/api/checkout', '/api/checkout/cart', '/api/checkout/confirm-setup', '/api/checkout/auto-draw', '/roccstar', '/some-product']) {
    assert.equal(merchantHostAllowsPath(p), true, p);
  }
  for (const p of ['/api/store/config', '/api/config/public', '/api/promo/validate', '/api/auth/me', '/api/ai/hero-animation',
    '/api/analytics/heartbeat', '/api/checkout/direct', '/api/checkout/cron-draw', '/api/cron/auto-draw', '/api/account/lookup', '/story', '/terms', '/account', '/admin', '/og', '/icon',
    '/auth/login', '/a/b', '/platform']) {
    assert.equal(merchantHostAllowsPath(p), false, p);
  }
});

test('the route list matches the app/ directory (a new page must not pass as a product slug)', () => {
  const appDir = join(import.meta.dirname, '..', 'app');
  const dirs = readdirSync(appDir).filter((n) => statSync(join(appDir, n)).isDirectory() && !n.startsWith('[') && !n.startsWith('(') && !n.startsWith('_'));
  for (const d of dirs) assert.ok(APP_TOP_LEVEL_ROUTES.includes(d), 'app/' + d + ' missing from APP_TOP_LEVEL_ROUTES');
});
