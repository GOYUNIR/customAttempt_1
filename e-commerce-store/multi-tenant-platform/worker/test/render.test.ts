import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSiteHtml } from '../src/render.ts';
import type { CompiledSite } from '../../shared/types.ts';

// The six characters: backslash + "u003c". Built at runtime so this test file
// never needs a literal backslash (which tooling/templating can mangle).
const BACKSLASH = String.fromCharCode(92);
const ESCAPED_LT = BACKSLASH + 'u003c';

function buildCompiled(overrides: Partial<CompiledSite> = {}): CompiledSite {
  return {
    cacheVersion: 1,
    site: {
      id: '00000000-0000-0000-0000-000000000001',
      owner_id: '00000000-0000-0000-0000-00000000000a',
      subdomain: 'demo',
      custom_domain: null,
      is_published: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    settings: {
      site_id: '00000000-0000-0000-0000-000000000001',
      site_name: 'Demo Store',
      theme_config: {
        colors: {
          background: '#f7f7f8', surface: '#ffffff', text: '#18181b',
          mutedText: '#52525b', primary: '#2563eb', primaryText: '#ffffff', border: '#e4e4e7',
        },
        fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' },
        radiusPx: 16,
        containerMaxWidthPx: 1120,
        spacing: 'comfortable',
      },
      layout_blocks: [
        { id: 'nav-1', type: 'nav', enabled: true, props: { links: [{ label: 'Shop', href: '/#shop' }], align: 'right' } },
        { id: 'hero-1', type: 'hero', enabled: true, props: { headline: 'Products, not pages.', subheadline: 'Fully data-driven.', ctaLabel: 'Shop', ctaHref: '/#shop', imageUrl: null, align: 'center' } },
        { id: 'products-1', type: 'products', enabled: true, props: { title: 'Featured', limit: 10, categories: ['New'], showPrices: true } },
      ],
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    products: [
      {
        id: '00000000-0000-0000-0000-000000000011',
        site_id: '00000000-0000-0000-0000-000000000001',
        name: 'Aurora Tee',
        description: 'Soft heavyweight cotton.',
        price: 45,
        image_url: 'https://picsum.photos/seed/aurora-tee/800/1000',
        is_active: true,
        sort_order: 0,
        tags: ['New'],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    compiledAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('renderSiteHtml: injects the compiled JSON and renders every section', () => {
  const html = renderSiteHtml(buildCompiled(), 'demo');
  assert.match(html, /<title>Demo Store<\/title>/);
  assert.match(html, /id="__SITE_DATA__"/);
  assert.match(html, /Products, not pages\./);
  assert.match(html, /Aurora Tee/);
  assert.match(html, /class="product-card"/);
  assert.match(html, /\$45\.00/); // Intl.NumberFormat currency
  assert.match(html, /data-filter-category="New"/);
  assert.match(html, /© 20\d\d Demo Store/);
});

test('renderSiteHtml: JSON is escaped so tenant data can never break out of the script tag', () => {
  const evil = buildCompiled({
    settings: {
      ...buildCompiled().settings,
      site_name: '</script><script>alert(1)</script>',
    },
  });
  const html = renderSiteHtml(evil, 'demo');
  const scriptStart = html.indexOf('id="__SITE_DATA__"');
  const scriptJson = html.slice(scriptStart, html.indexOf('</script>', scriptStart));

  // The literal breakout sequence must never appear inside the JSON payload…
  assert.ok(!scriptJson.includes('</script><script>alert'));
  // …because every "<" is rewritten to the six characters "\u003c".
  assert.ok(scriptJson.includes(ESCAPED_LT));
  // The visible <title> escapes the value too.
  assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderSiteHtml: disabled blocks and empty products render cleanly', () => {
  const compiled = buildCompiled({
    settings: {
      ...buildCompiled().settings,
      layout_blocks: [
        { id: 'hero-1', type: 'hero', enabled: false, props: { headline: 'Hidden', subheadline: '', ctaLabel: '', ctaHref: '/', imageUrl: null, align: 'center' } },
        { id: 'products-1', type: 'products', enabled: true, props: { title: 'Featured', limit: 10, categories: [], showPrices: true } },
      ],
    },
    products: [],
  });
  const html = renderSiteHtml(compiled, 'demo');
  // The disabled block's data is still in the JSON blob (harmless), but it must
  // NOT be rendered as visible markup in <main>.
  assert.ok(!html.includes('<h1>Hidden</h1>'));
  assert.match(html, /class="product-grid"/);
});
