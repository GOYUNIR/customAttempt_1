import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STARTER_TEMPLATES, normalizeTheme, templateById, templatesForCommerceMode, validateTheme,
} from '../lib/theme-templates.ts';
import { THEME_PAGES, sectionAllowedOn } from '../lib/theme-schema.ts';

test('every starter template is internally valid', () => {
  for (const t of STARTER_TEMPLATES) {
    const result = validateTheme({ version: 2, pages: t.pages });
    assert.equal(result.ok, true, `${t.id}: ${result.errors.join('; ')}`);
  }
});

test('every starter template covers all three pages — not just the homepage', () => {
  // The whole point: the old system themed the front page and left the product
  // page and catalog hardcoded, which is most of what a shopper looks at.
  for (const t of STARTER_TEMPLATES) {
    for (const page of THEME_PAGES) {
      assert.ok((t.pages[page] || []).length > 0, `${t.id} has no ${page} sections`);
    }
  }
});

test('a drop template shows scarcity; a retail one does not', () => {
  // Urgency on an always-in-stock product is a lie a customer catches by
  // reloading. On a draw it is true.
  const drop = templateById('drop-release')!;
  const retail = templateById('instant-retail')!;
  const summaryOf = (t: typeof drop) => t.pages.product.find((s) => s.type === 'product_summary')!;
  assert.equal(summaryOf(drop).config.showUrgency, true);
  assert.equal(summaryOf(retail).config.showUrgency, false);
});

test('the B2B template does not show retail price or a retail cart', () => {
  const b2b = templateById('b2b-quote')!;
  const summary = b2b.pages.product.find((s) => s.type === 'product_summary')!;
  assert.equal(summary.config.showPrice, false, 'contract pricing means list price misleads');
  assert.equal(summary.config.ctaLabel, 'Request a quote');
  assert.equal(summary.config.showUrgency, false);
  const filters = b2b.pages.catalog.find((s) => s.type === 'catalog_filters')!;
  assert.equal(filters.config.showPriceRange, false);
});

test('templatesForCommerceMode puts the best fit first but still offers the rest', () => {
  const forDraw = templatesForCommerceMode('ALLOCATION_DRAW');
  assert.equal(forDraw[0].id, 'drop-release');
  assert.equal(forDraw.length, STARTER_TEMPLATES.length, 'nothing is hidden');
  assert.equal(templatesForCommerceMode('INSTANT_BUY')[0].id, 'instant-retail');
  // An unknown mode must not throw or return nothing.
  assert.equal(templatesForCommerceMode('SOMETHING_NEW').length, STARTER_TEMPLATES.length);
});

test('a LEGACY bare array still renders, as a home-only theme', () => {
  // tenant_themes.sections currently holds a flat array. No migration should be
  // needed and no existing theme may stop rendering.
  const legacy = [{ id: 'hero-1', type: 'hero', order: 0, config: {} }];
  const theme = normalizeTheme(legacy);
  assert.equal(theme.version, 2);
  assert.equal(theme.pages.home.length, 1);
  assert.deepEqual(theme.pages.catalog, []);
});

test('normalizeTheme never throws on junk — a bad row must not take a storefront down', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, { pages: 'no' }, { pages: { home: 'no' } }]) {
    const theme = normalizeTheme(junk);
    assert.equal(theme.version, 2);
    for (const page of THEME_PAGES) assert.deepEqual(theme.pages[page], []);
  }
  // Entries that are not sections are dropped rather than rendered as blanks.
  assert.deepEqual(normalizeTheme([1, null, { nope: true }]).pages.home, []);
});

test('placement is enforced — a product section cannot be put on the homepage', () => {
  assert.equal(sectionAllowedOn('product_summary', 'home'), false);
  assert.equal(sectionAllowedOn('product_summary', 'product'), true);
  assert.equal(sectionAllowedOn('catalog_filters', 'product'), false);
  assert.equal(sectionAllowedOn('footer', 'catalog'), true);

  const bad = validateTheme({
    version: 2,
    pages: { home: [{ id: 'x', type: 'product_summary', order: 0, config: {} }], catalog: [], product: [] },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /cannot be placed on the home page/);
});

test('validateTheme catches duplicate ids and unknown types', () => {
  const dupes = validateTheme({
    version: 2,
    pages: {
      home: [
        { id: 'same', type: 'hero', order: 0, config: {} },
        { id: 'same', type: 'banner', order: 1, config: {} },
      ],
      catalog: [], product: [],
    },
  });
  assert.equal(dupes.ok, false);
  assert.match(dupes.errors.join(' '), /duplicate id/);

  const unknown = validateTheme({
    version: 2,
    pages: { home: [{ id: 'a', type: 'not_a_real_section' as never, order: 0, config: {} }], catalog: [], product: [] },
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(' '), /unknown section type/);
});

test('every commerce mode a template claims is a REAL commerce mode', async () => {
  // Guards a typo that would make a template unreachable for the mode it was
  // written for, while still looking correct in the file.
  const { COMMERCE_MODES } = await import('../lib/commerce-modes.ts');
  const known = new Set<string>(COMMERCE_MODES as readonly string[]);
  for (const t of STARTER_TEMPLATES) {
    assert.ok(t.commerceModes.length > 0, `${t.id} claims no commerce mode`);
    for (const mode of t.commerceModes) {
      assert.ok(known.has(mode), `${t.id} references unknown commerce mode "${mode}"`);
    }
  }
});

test('the modes with NO starter template are known and few', async () => {
  // Not a failure — an honest inventory, so "which modes can a merchant launch
  // fast in?" has an answer instead of an assumption.
  const { COMMERCE_MODES } = await import('../lib/commerce-modes.ts');
  const covered = new Set(STARTER_TEMPLATES.flatMap((t) => t.commerceModes));
  const uncovered = (COMMERCE_MODES as readonly string[]).filter((m) => !covered.has(m));
  assert.deepEqual(uncovered.sort(), ['DUTCH_AUCTION', 'PAY_WHAT_YOU_WANT']);
});
