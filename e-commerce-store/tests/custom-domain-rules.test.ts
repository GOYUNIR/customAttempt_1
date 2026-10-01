import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHostname, normalizeHostname, ownershipRecordName, domainCapAllows } from '../lib/custom-domain-rules.ts';

const ctx = { platformRoots: ['goyunir.com', 'newplatform.example'] };
const ok = (h: string) => checkHostname(h, ctx).ok;

test('normalizing what people paste', () => {
  assert.equal(normalizeHostname('HTTPS://Shop.Example.com:443/path?x=1'), 'shop.example.com');
  assert.equal(normalizeHostname(' www.example.com. '), 'www.example.com');
});

test('a store may connect a subdomain of a domain it owns', () => {
  for (const h of ['www.northloopcandles.com', 'shop.example.co.uk', 'store.my-brand.io']) assert.ok(ok(h), h);
});

test('a bare root domain gets a plain suggestion (root domains need Enterprise)', () => {
  const r = checkHostname('example.com', ctx);
  assert.ok(!r.ok && r.suggestion === 'www.example.com' && /forward example\.com/.test(r.reason));
});

test('platform domains and anything under them are refused', () => {
  for (const h of ['goyunir.com', 'www.goyunir.com', 'test4.goyunir.com', 'app.goyunir.com', 'x.newplatform.example']) {
    const r = checkHostname(h, ctx);
    assert.ok(!r.ok && /belongs to the platform/.test(r.reason), h);
  }
  assert.ok(ok('www.notgoyunir.com'), 'a lookalike that is not under the root is a different domain');
});

test('junk is refused', () => {
  for (const h of ['', 'localhost', '1.2.3.4', 'www.example.123', 'bad_host.example.com', '-x.example.com', 'a'.repeat(64) + '.example.com']) assert.ok(!ok(h), JSON.stringify(h));
});

test('ownership record and plan cap', () => {
  assert.equal(ownershipRecordName('www.example.com'), '_store-verify.www.example.com');
  assert.equal(domainCapAllows(1, 0), true);
  assert.equal(domainCapAllows(1, 1), false);
  assert.equal(domainCapAllows(3, 2), true);
  assert.equal(domainCapAllows(null, 500), true, 'null = unlimited (Scale)');
});
