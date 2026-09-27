import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  storeFromHeader, sendingAddressOf, esc, money,
  renderOrderConfirmed, renderEntryReceived, renderEntryCharged, type StoreIdentity,
} from '../lib/tenant-email-render.ts';

const store: StoreIdentity = { name: 'Fern & Co <b>', supportEmail: 'help@fern.example', storeUrl: 'https://fern.example.com' };
const bare: StoreIdentity = { name: 'Quiet Shop', supportEmail: null, storeUrl: 'https://quiet.example.com' };

test('the sender is the STORE, with a header-safe name, at the platform address', () => {
  assert.equal(storeFromHeader('Fern & Co', 'orders@platform.example'), '"Fern & Co" <orders@platform.example>');
  assert.equal(storeFromHeader('Evil"\r\nBcc: x@y.z <a>', 'o@p.example'), '"Evil Bcc: x@y.z a" <o@p.example>');
  assert.equal(storeFromHeader('', 'o@p.example'), '"Store" <o@p.example>');
  assert.equal(sendingAddressOf('Original Brand <orders@platform.example>'), 'orders@platform.example');
  assert.equal(sendingAddressOf('orders@platform.example'), 'orders@platform.example');
  assert.equal(sendingAddressOf(''), null);
  assert.equal(sendingAddressOf('Just a name'), null);
});

test('order confirmation: the store\'s name, the lines, the total, escaped', () => {
  const m = renderOrderConfirmed(store, {
    orderRef: 'FERN-1', currency: 'usd', totalCents: 4550,
    lines: [{ productName: 'Tee <script>alert(1)</script>', size: 'M', quantity: 2, amountCents: 3000 }, { productName: 'Cap', size: '', quantity: 1, amountCents: 1550 }],
  });
  assert.equal(m.subject, 'Your order from Fern & Co <b> (FERN-1)');
  assert.ok(m.html.includes('Fern &amp; Co &lt;b&gt;'), 'store name escaped');
  assert.ok(!m.html.includes('<script>') && m.html.includes('&lt;script&gt;'), 'product name escaped');
  assert.ok(m.html.includes('$45.50') && m.text.includes('Total: $45.50'));
  assert.ok(m.html.includes('help@fern.example') && m.text.includes('help@fern.example'), 'the store\'s own support address');
});

test('without a support address: the store\'s own site, never anyone else\'s contact', () => {
  const m = renderEntryReceived(bare, { kind: 'raffle', product: 'Boot', size: '9' });
  assert.ok(m.html.includes('https://quiet.example.com') && !/Reply to this email/.test(m.html));
});

test('entry emails make exactly the promise the store\'s page makes', () => {
  const r = renderEntryReceived(store, { kind: 'raffle', product: 'Boot', size: '9' });
  assert.equal(r.subject, "You're entered: Boot (9)");
  assert.ok(r.text.includes('Your saved card is charged only if you win.'));
  const w = renderEntryReceived(store, { kind: 'waitlist', product: 'Boot', size: '9' });
  assert.equal(w.subject, "You're on the waitlist: Boot (9)");
  assert.ok(w.text.includes('charged only if one is available when it goes on sale'));
});

test('charged: what was bought, what was charged, the order', () => {
  const r = renderEntryCharged(store, { kind: 'raffle', product: 'Boot', size: '9', amountCents: 12000, currency: 'eur', orderRef: 'FERN-9' });
  assert.equal(r.subject, 'You won: Boot (9)');
  assert.ok(r.text.includes('charged €120.00') && r.text.includes('Order FERN-9'));
  const w = renderEntryCharged(store, { kind: 'waitlist', product: 'Boot', size: '9', amountCents: 12000, currency: 'usd', orderRef: 'FERN-10' });
  assert.equal(w.subject, "It's yours: Boot (9)");
});

test('helpers', () => {
  assert.equal(esc(`<a href="x">'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;');
  assert.equal(money(199, 'usd'), '$1.99');
  assert.equal(money(199, ''), '$1.99');
});

// Structural: the store-email path can never pick up the original store.
test('store emails never reach for the original store\'s brand, logo, contact or templates', () => {
  const root = join(import.meta.dirname, '..');
  for (const f of ['lib/tenant-email.ts', 'lib/tenant-email-render.ts']) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const banned of ['getBrandName', 'getSupportEmail', 'getBrandLogo', 'emailBrandName', 'emailLogoHtml', 'getResend', 'sendEntryConfirmedEmail', 'GOYUNIR_STORE_SUITE', "from '@/lib/env'"]) {
      assert.ok(!src.includes(banned), f + ' must not use ' + banned);
    }
  }
  for (const f of ['lib/tenant-checkout.ts', 'lib/tenant-drops.ts']) {
    const src = readFileSync(join(root, f), 'utf8');
    assert.ok(!src.includes("from '@/lib/email'"), f + ' must send customer email only through lib/tenant-email.ts');
  }
  const render = readFileSync(join(root, 'lib/tenant-email-render.ts'), 'utf8');
  assert.ok(!/^import /m.test(render), 'the render module stays import-free');
});
