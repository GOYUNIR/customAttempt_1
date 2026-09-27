import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateMerchantProduct } from '../lib/merchant-product-input.ts';

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
    for (const banned of ['ensureDefaultTenant', 'resolveActingTenantId', 'createKvClient', 'DEFAULT_TENANT_ID', "from '@/lib/tenant-context'", 'searchParams.get(\'tenant', 'body.tenant', 'x-tenant']) {
      assert.ok(!src.includes(banned), f + ' must not use ' + banned);
    }
  }
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
