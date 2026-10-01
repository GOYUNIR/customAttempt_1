import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMediaRef, toMediaRef, validMediaKey } from '../lib/media-key.ts';

const base = 'https://media.example.com';

test('media keys: a key resolves against the base given at READ time', () => {
  assert.equal(resolveMediaRef('media:tenants/t1/products/a.jpg', base), base + '/tenants/t1/products/a.jpg');
  assert.equal(resolveMediaRef('media:tenants/t1/products/a.jpg', 'https://cdn.newdomain.example/'), 'https://cdn.newdomain.example/tenants/t1/products/a.jpg', 'a domain move changes the base only');
});

test('media keys: older values keep working exactly as stored', () => {
  for (const v of [base + '/tenants/t1/products/a.jpg', '/images/seed/1.jpeg', 'https://other.example/x.png', 'data:image/png;base64,AAAA', ''])
    assert.equal(resolveMediaRef(v, base), v);
});

test('media keys: an unsafe key never resolves to anything', () => {
  for (const k of ['media:../x.jpg', 'media:tenants/t1/../t2/a.jpg', 'media:/etc/passwd', 'media:tenants//a.jpg', 'media:a/./b',
    'media:https://evil.example/x', 'media:tenants/t1/a.jpg?x=1', 'media:%2e%2e/x', 'media:', 'media:a\\b'])
    assert.equal(resolveMediaRef(k, base), '', k);
  assert.equal(resolveMediaRef('media:tenants/t1/products/a.jpg', ''), '', 'no base configured: nothing');
});

test('media keys: only our own host becomes a key on write', () => {
  assert.equal(toMediaRef(base + '/tenants/t1/products/a.jpg', base), 'media:tenants/t1/products/a.jpg');
  assert.equal(toMediaRef(base + '/tenants/t1/products/a.jpg?v=2', base), 'media:tenants/t1/products/a.jpg');
  assert.equal(toMediaRef('https://media.example.com.evil.example/a.jpg', base), null, 'lookalike host');
  assert.equal(toMediaRef('https://other.example/a.jpg', base), null);
  assert.equal(toMediaRef('/images/seed/1.jpeg', base), null);
  assert.equal(toMediaRef(base + '/tenants/t1/../t2/a.jpg', base), null);
  assert.equal(toMediaRef('media:tenants/t1/products/a.jpg', base), 'media:tenants/t1/products/a.jpg');
  assert.equal(toMediaRef('media:../a.jpg', base), null);
  assert.ok(validMediaKey('tenants/0b5e/products/9f.webp'));
  assert.ok(!validMediaKey('x'.repeat(401)));
});
