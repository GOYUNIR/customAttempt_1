import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateShipInput, stripePaymentLink, orderStage, CARRIERS } from '../lib/fulfilment-rules.ts';
import { renderOrderShipped } from '../lib/tenant-email-render.ts';

test('ship input: a known carrier and a tracking number; spaces from a label are dropped', () => {
  const r = validateShipInput({ carrier: 'UPS', trackingNumber: ' 1Z 999 AA1 0123456784 ' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.trackingNumber, '1Z999AA10123456784');
    assert.equal(r.value.carrierName, 'UPS');
    assert.equal(r.value.trackingUrl, 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
  }
});

test('ship input: refused when it is not a tracking number or not a carrier', () => {
  for (const bad of [{}, { carrier: 'ups' }, { carrier: 'ups', trackingNumber: 'abc' }, { carrier: 'ups', trackingNumber: '<script>x</script>' },
    { carrier: 'ups', trackingNumber: 'x'.repeat(65) }, { carrier: 'pigeon', trackingNumber: '12345678' }, { carrier: 'other', trackingNumber: '12345678' }])
    assert.equal(validateShipInput(bad).ok, false, JSON.stringify(bad));
});

test('"Other" carrier: named by the merchant, no tracking link, name made safe', () => {
  const r = validateShipInput({ carrier: 'other', carrierName: 'Canada <b>Post</b>', trackingNumber: 'RR123456789CA' });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.value.trackingUrl, null); assert.doesNotMatch(r.value.carrierName, /[<>]/); }
});

test('every carrier link is https and encodes the number', () => {
  for (const c of CARRIERS) if (c.trackingUrl) assert.match(c.trackingUrl('AB-12'), /^https:\/\/[^\s]+AB-12$/);
});

test('the Stripe Dashboard link: test or live, and only for a real PaymentIntent id', () => {
  assert.equal(stripePaymentLink('pi_3Abc', true), 'https://dashboard.stripe.com/test/payments/pi_3Abc');
  assert.equal(stripePaymentLink('pi_3Abc', false), 'https://dashboard.stripe.com/payments/pi_3Abc');
  assert.equal(stripePaymentLink('javascript:alert(1)', false), null);
  assert.equal(stripePaymentLink(null, false), null);
});

test('order stage', () => {
  assert.equal(orderStage({ paymentStatus: 'paid', shippedAt: null }), 'to_ship');
  assert.equal(orderStage({ paymentStatus: 'partially_refunded', shippedAt: null }), 'to_ship');
  assert.equal(orderStage({ paymentStatus: 'paid', shippedAt: '2026-10-01' }), 'shipped');
  assert.equal(orderStage({ paymentStatus: 'refunded', shippedAt: '2026-10-01' }), 'refunded');
  assert.equal(orderStage({ paymentStatus: 'unpaid', shippedAt: null }), 'unpaid');
});

test('the shipped email: from the store, escaped, with the tracking link and no original-store branding', () => {
  const m = renderOrderShipped({ name: 'Salt & <Cedar>', supportEmail: 'help@salt.example', storeUrl: null }, {
    orderRef: 'SALT-1', carrier: 'UPS', trackingNumber: '1Z999', trackingUrl: 'https://www.ups.com/track?tracknum=1Z999',
    lines: [{ productName: 'Mug <b>', size: 'L', quantity: 2 }],
  });
  assert.match(m.subject, /^Your order from Salt & <Cedar> has shipped \(SALT-1\)$/);
  assert.match(m.html, /Salt &amp; &lt;Cedar&gt;/);
  assert.match(m.html, /Mug &lt;b&gt; \(L\) &times; 2/);
  assert.match(m.html, /href="https:\/\/www\.ups\.com\/track\?tracknum=1Z999"/);
  assert.match(m.text, /Track it: https:\/\/www\.ups\.com/);
  assert.match(m.html, /help@salt\.example/);
});
