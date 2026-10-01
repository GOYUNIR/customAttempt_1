import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateMerchantProduct } from '../lib/merchant-product-input.ts';
import { sniffImage } from '../lib/image-sniff.ts';

// STRUCTURAL GUARD for the merchant dashboard's API (TENANCY.md). Every
// /api/merchant handler must pass the ONE session gate before anything else,
// and may not reach for the original store's data sources. A route added later
// without the gate fails here, before it can ship.
const ROOT = join(import.meta.dirname, '..', 'app', 'api', 'merchant');
const routeFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? routeFiles(p) : n === 'route.ts' ? [p] : [];
});

test('every /api/merchant handler passes merchantSession() first', () => {
  const files = routeFiles(ROOT);
  assert.ok(files.length > 0, 'no merchant routes found');
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(request: Request\) \{\n([^\n]*)\n([^\n]*)\n/g)];
    const exported = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].length;
    assert.equal(handlers.length, exported, f + ': every handler must take (request: Request)');
    for (const h of handlers) {
      assert.equal(h[2].trim(), 'const gate = await merchantSession(request);', f + ' ' + h[1] + ': first line must be the gate');
      assert.equal(h[3].trim(), 'if (!gate.ok) return gate.response;', f + ' ' + h[1] + ': second line must return the refusal');
    }
  }
});

test('no /api/merchant route reaches for the original store\'s data', () => {
  for (const f of routeFiles(ROOT)) {
    const src = readFileSync(f, 'utf8');
    for (const banned of ['ensureDefaultTenant', 'resolveActingTenantId', 'createKvClient', 'DEFAULT_TENANT_ID', "from '@/lib/tenant-context'", 'searchParams.get(\'tenant', 'body.tenant', 'x-tenant', 'appendAudit', 'AUDIT_LOG_KEY']) {
      assert.ok(!src.includes(banned), f + ' must not use ' + banned);
    }
  }
});

// The gate itself needs the shared KV for sessions, so the route ban above
// cannot cover it. What it must never do is write the ORIGINAL store's admin
// audit list (admin:audit_log): merchant audit goes to the store-tagged
// platform table only.
test('merchant audit never lands in the original store\'s admin audit log', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'lib', 'merchant-session.ts'), 'utf8');
  for (const banned of ['appendAudit', 'AUDIT_LOG_KEY', 'admin:audit_log', "'@/app/api/admin/audit/route'"]) {
    assert.ok(!src.includes(banned), 'lib/merchant-session.ts must not use ' + banned);
  }
  assert.ok(src.includes('recordPlatformAudit('), 'merchant audit must go to the platform table');
});

const good = { name: 'Summer Tee', sizes: [{ size: 'M', price: 24, mode: 'FCFS', stock: 5 }] };

test('a valid product passes, with a slug made from the name', () => {
  const r = validateMerchantProduct(good);
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.value.slug, 'summer-tee'); assert.equal(r.value.sizes[0].stock, 5); assert.equal((r.value as any).tenantId, undefined); }
});

test('the store can never come from the input', () => {
  const r = validateMerchantProduct({ ...good, tenantId: 'someone-else', tenant_id: 'x' });
  assert.ok(r.ok);
  if (r.ok) { assert.equal((r.value as any).tenantId, undefined); assert.equal((r.value as any).tenant_id, undefined); }
});

test('reserved and malformed web addresses are refused', () => {
  for (const slug of ['catalog', 'api', 'admin', 'terms', 'Bad Slug', '-x', 'a'.repeat(61)]) {
    assert.equal(validateMerchantProduct({ ...good, slug }).ok, false, slug);
  }
});

test('prices, stock, sizes and limits are bounded', () => {
  const bad = [
    { ...good, sizes: [] },
    { ...good, sizes: [{ size: 'M', price: 0.1 }] },
    { ...good, sizes: [{ size: 'M', price: 10.001 }] },
    { ...good, sizes: [{ size: 'M', price: 10, stock: -1 }] },
    { ...good, sizes: [{ size: 'M', price: 10, stock: 1.5 }] },
    { ...good, sizes: [{ size: 'M', price: 10, mode: 'AUCTION' }] },
    { ...good, sizes: [{ size: 'M', price: 10 }, { size: 'm', price: 12 }] },
    { ...good, maxPerEmail: 0 },
    { ...good, name: '' },
    { ...good, id: '../../etc' },
    { ...good, isActive: true, sizes: [{ size: 'M', price: 10, mode: 'RAFFLE' }] }, // live raffle, no draw date
  ];
  for (const b of bad) assert.equal(validateMerchantProduct(b).ok, false, JSON.stringify(b));
});

import { validateMerchantSettings } from '../lib/merchant-settings-input.ts';

test('settings: bounded, store never from the input, empty policies allowed (= not published)', () => {
  const ok = validateMerchantSettings({ brandName: 'Atelier', hero: { headline: 'Hi' }, legal: { supportEmail: 'Help@Atelier.test', terms: '' }, tenantId: 'x' });
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.value.legal.supportEmail, 'help@atelier.test'); assert.equal((ok.value as any).tenantId, undefined); assert.equal(ok.value.legal.terms, ''); }
  for (const bad of [
    { brandName: 'x'.repeat(81) },
    { hero: { headline: 'x'.repeat(121) } },
    { legal: { supportEmail: 'not an email' } },
    { legal: { terms: 'x'.repeat(20001) } },
  ]) assert.equal(validateMerchantSettings(bad).ok, false, JSON.stringify(bad).slice(0, 60));
});

test('stock input: whole units, a real size id, the store never from the input', async () => {
  const { validateStockSet, validateStockAdjust, validateVariantParam } = await import('../lib/merchant-stock-input.ts');
  const V = '1e02eebc-af34-4f52-b57d-5227b6633589';
  assert.deepEqual(validateStockSet({ variantId: V, count: 12, note: '  shelf   count ', tenantId: 'x' }), { ok: true, value: { variantId: V, count: 12, note: 'shelf count' } });
  for (const count of [-1, 1.5, 'abc', null, undefined, '', '  ', 1_000_001]) assert.equal(validateStockSet({ variantId: V, count }).ok, false, 'count ' + count);
  assert.equal(validateStockSet({ variantId: 'not-a-uuid', count: 1 }).ok, false);
  const a = validateStockAdjust({ variantId: V, delta: 5 });
  assert.ok(a.ok && a.value.reason === 'restock');
  const d = validateStockAdjust({ variantId: V, delta: -2 });
  assert.ok(d.ok && d.value.reason === 'adjust');
  for (const delta of [0, 2.5, 'x', 2_000_000]) assert.equal(validateStockAdjust({ variantId: V, delta }).ok, false, 'delta ' + delta);
  assert.equal(validateStockAdjust({ variantId: V, delta: 1, reason: 'sale' }).ok, false, 'a sale is never a manual reason');
  assert.equal(validateVariantParam("1' or 1=1"), null);
});

test('product photos: a new photo must be THIS store\'s own upload; photos already on the product may stay', () => {
  const mediaBase = 'https://media.example.com/media/r2';
  const mine = mediaBase + '/tenants/store-a/products/abc.jpg';
  const theirs = mediaBase + '/tenants/store-b/products/xyz.jpg';
  const opts = { mediaBase, tenantId: 'store-a' };
  const ok = validateMerchantProduct({ ...good, images: [mine] }, opts);
  assert.ok(ok.ok && ok.value.images?.length === 1, 'own upload accepted');
  assert.ok(!validateMerchantProduct({ ...good, images: [theirs] }, opts).ok, "another store's upload is refused");
  assert.ok(!validateMerchantProduct({ ...good, images: ['https://evil.example/x.jpg'] }, opts).ok, 'a hotlink is refused');
  assert.ok(!validateMerchantProduct({ ...good, images: [mediaBase + '/tenants/store-a-evil/products/x.jpg'] }, opts).ok, 'a lookalike store id is refused');
  assert.ok(validateMerchantProduct({ ...good, images: [theirs] }, { ...opts, currentImages: [theirs] }).ok, 'a photo already on this product may stay');
  assert.ok(!validateMerchantProduct({ ...good, images: Array(9).fill(mine) }, opts).ok, 'more than 8 is refused');
  assert.ok(!validateMerchantProduct({ ...good, images: [mine] }, { tenantId: 'store-a' }).ok, 'no configured media host: refused');
  const untouched = validateMerchantProduct(good, opts);
  assert.ok(untouched.ok && untouched.value.images === undefined, 'no images field = keep current photos');
  // Found 2026-10-01: these passed the old "starts with my prefix" check.
  for (const sneaky of [
    mediaBase + '/tenants/store-a/products/../../store-b/products/xyz.jpg',
    mediaBase + '/tenants/store-a/products/%2e%2e/%2e%2e/store-b/products/xyz.jpg',
    mediaBase + '/tenants/store-a/products//xyz.jpg',
    'media:tenants/store-a/products/../../store-b/products/xyz.jpg',
    'media:tenants/store-b/products/xyz.jpg',
  ]) assert.ok(!validateMerchantProduct({ ...good, images: [sneaky] }, opts).ok, 'refused: ' + sneaky);
  assert.ok(validateMerchantProduct({ ...good, images: ['media:tenants/store-a/products/abc.jpg'] }, opts).ok, 'own key accepted');
});

test('an upload is judged by its bytes, not its name or claimed type', () => {
  const pad = (a: number[]) => new Uint8Array([...a, ...Array(16).fill(0)]);
  assert.equal(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))?.contentType, 'image/jpeg');
  assert.equal(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.contentType, 'image/png');
  assert.equal(sniffImage(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]))?.contentType, 'image/webp');
  assert.equal(sniffImage(new Uint8Array([0, 0, 0, 0x1c, ...Buffer.from('ftypavif'), 0, 0, 0, 0]))?.contentType, 'image/avif');
  assert.equal(sniffImage(pad([...Buffer.from('<svg xmlns=')])), null, 'SVG (can carry script) is refused');
  assert.equal(sniffImage(pad([...Buffer.from('<!DOCTYPE html>')])), null, 'HTML renamed .jpg is refused');
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8])), null, 'too short to be an image');
});
