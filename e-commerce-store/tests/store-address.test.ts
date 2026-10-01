import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStoreAddress, normalizeAddressInput } from '../lib/store-address.ts';
import { parseLegacyHosts } from '../lib/storefront-host.ts';

const ctx = { legacyHosts: parseLegacyHosts('shop,www,api,goyunir', 'example.com'), rootDomain: 'example.com' };
const ok = (s: string) => checkStoreAddress(s, ctx).ok;

test('ordinary shop names are accepted', () => {
  for (const s of ['salt-and-cedar', 'north-loop-candles', 'studio42', 'maison-verte', 'apple-orchard-honey', 'square-foot-bakery', 'wise-owl-books', 'otherwise-studio', 'striped-socks', 'pinstripe-tailor', 'gazelle-running']) assert.ok(ok(s), s);
  assert.equal(normalizeAddressInput('  My Shop_Name '), 'my-shop-name');
});

test('format rules', () => {
  for (const s of ['ab', 'a'.repeat(41), '-start', 'end-', 'two--hyphens', 'dots.not.allowed', 'emoji😀']) assert.ok(!ok(s), s);
});

test('platform-reserved names and legacy hosts are refused', () => {
  for (const s of ['admin', 'app', 'sales', 'www', 'shop', 'api', 'goyunir']) assert.ok(!ok(s), s);
});

test('payment, bank and big-tech lookalikes are refused, including disguised ones', () => {
  for (const s of ['paypal', 'paypa1-help', 'pay-pal', 'stripe-billing', 'stripe', 'zelle-pay', 'g00gle-store', 'my-appleid', 'appleid-login', 'squareup', 'transferwise', 'amazon-deals', 'coinbase', 'wellsfargo-secure',
    'visa', 'chase-alerts', 'my-bank', 'hsbc-uk', 'store-login', 'verify-account', 'secure-checkout', 'official-shop', 'support-desk', 'wallet-app']) {
    assert.ok(!ok(s), s + ' must be refused');
  }
});

test('the reason is stated plainly', () => {
  const r = checkStoreAddress('paypa1', ctx);
  assert.ok(!r.ok && /bank, payment or tech brand/.test(r.reason));
});
