import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKeysForSite } from '../src/publish.ts';
import type { PublishSiteInput } from '../../shared/types.ts';

const BASE_INPUT: PublishSiteInput = {
  siteId: '00000000-0000-0000-0000-000000000001',
  subdomain: 'Demo',
  customDomain: null,
  siteName: 'Demo Store',
  themeConfig: {
    colors: {
      background: '#f7f7f8', surface: '#ffffff', text: '#18181b',
      mutedText: '#52525b', primary: '#2563eb', primaryText: '#ffffff', border: '#e4e4e7',
    },
    fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' },
    radiusPx: 16,
    containerMaxWidthPx: 1120,
    spacing: 'comfortable',
  },
  layoutBlocks: [],
  products: [],
  isPublished: true,
};

test('buildCacheKeysForSite: platform subdomain only', () => {
  assert.deepEqual(buildCacheKeysForSite(BASE_INPUT, 1), ['site_cache:v1:demo']);
});

test('buildCacheKeysForSite: custom domain adds a second key (www normalized)', () => {
  const withDomain: PublishSiteInput = { ...BASE_INPUT, customDomain: 'www.Shop.Acme.com' };
  const keys = buildCacheKeysForSite(withDomain, 2);
  assert.deepEqual(keys, ['site_cache:v2:demo', 'site_cache:v2:shop.acme.com']);
});

test('buildCacheKeysForSite: subdomain is normalized + deduped', () => {
  const weird: PublishSiteInput = { ...BASE_INPUT, subdomain: 'Demo', customDomain: 'demo' };
  const keys = buildCacheKeysForSite(weird, 1);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], 'site_cache:v1:demo');
});
