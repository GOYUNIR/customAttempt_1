import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buyLabel, entryLabel, cardLabel } from '../lib/buy-labels.ts';

test('every store gets plain, consequence-stating buy labels by default', () => {
  assert.equal(buyLabel({}, 19), 'Buy now · $19.00');
  assert.equal(buyLabel(null, 7.5), 'Buy now · $7.50');
  assert.equal(entryLabel({}, false), 'Enter the raffle');
  assert.equal(entryLabel(undefined, true), 'Enter the next raffle');
});

test("a store's own voice is an override, never the default", () => {
  const goyunir = { buyCta: 'Secure piece', entryCta: 'Enter allocation' };
  assert.equal(buyLabel(goyunir, 19), 'Secure piece · $19.00');
  assert.equal(entryLabel(goyunir, false), 'Enter allocation');
  assert.equal(buyLabel({ buyCta: '   ' }, 19), 'Buy now · $19.00', 'a blank override falls back');
});

test('no product-page component hardcodes one store\'s button wording', () => {
  for (const f of ['components/Storefront.tsx', 'components/ProductLivePreview.tsx', 'components/storefront/LegacyHomePage.tsx', 'components/storefront/LegacyCatalogPage.tsx']) {
    const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/'Enter allocation'|`Secure piece|'Secure piece|Re-enter for future return/.test(code), f);
  }
});

test('a product card says what its product page offers', () => {
  assert.equal(cardLabel({}, { checkoutMode: 'FCFS' }), 'Shop now');
  assert.equal(cardLabel({}, { checkoutMode: 'RAFFLE' }), 'Enter the raffle');
  assert.equal(cardLabel({ entryCta: 'Enter allocation' }, { checkoutMode: 'RAFFLE' }), 'Enter allocation');
  assert.equal(cardLabel({}, { checkoutMode: 'RAFFLE', isUpcoming: true }), 'Reserve your place');
  assert.equal(cardLabel({}, { checkoutMode: 'FCFS', soldOut: true }), 'Sold out');
});
