/**
 * A TEST product in a non-default tenant's own Postgres catalog (TENANCY.md
 * phase 2), written through the same catalog writer the admin uses.
 *
 *   npx tsx scripts/seed-tenant-test-product.ts [tenantId]    (default: test4)
 *
 * Idempotent on (tenant, slug). Stock rows are create-if-missing, so running
 * it again never resets sold units.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const p = join(process.cwd(), '.env.local');
if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }

const TENANT = process.argv[2] || '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
(async () => {
  const { writeProductToPostgres } = await import('../lib/catalog-write');
  const { DEFAULT_TENANT_ID } = await import('../lib/tenant-context');
  if (TENANT === DEFAULT_TENANT_ID) throw new Error('refusing to seed test data into the default store');
  const res = await writeProductToPostgres(TENANT, {
    id: 'prod_tenant_test_1',
    name: 'Connect Test Item',
    slug: 'connect-test-item',
    tagline: 'Test product for verifying checkout on this store (test mode).',
    desc: 'Test product for verifying checkout on this store (test mode).',
    isActive: true, isArchived: false, isUpcoming: false,
    checkoutMode: 'FCFS', productType: 'fcfs', isRaffle: false,
    maxPerEmail: 3, maxPerCart: 3,
    totalInventory: 10,
    inventoryPerSize: { 'One Size': 10 },
    priceCategories: [{ size: 'One Size', price: 19, checkoutMode: 'FCFS' }],
    notes: [], images: [], categories: [],
  });
  console.log(JSON.stringify(res));
  // A second product with two sizes, so a cart can hold several lines (phase 3).
  const res2 = await writeProductToPostgres(TENANT, {
    id: 'prod_tenant_test_2',
    name: 'Connect Test Pair',
    slug: 'connect-test-pair',
    tagline: 'Second test product for verifying cart checkout on this store (test mode).',
    desc: 'Second test product for verifying cart checkout on this store (test mode).',
    isActive: true, isArchived: false, isUpcoming: false,
    checkoutMode: 'FCFS', productType: 'fcfs', isRaffle: false,
    maxPerEmail: 5, maxPerCart: 5,
    totalInventory: 20,
    inventoryPerSize: { Small: 10, Large: 10 },
    priceCategories: [{ size: 'Small', price: 12, checkoutMode: 'FCFS' }, { size: 'Large', price: 24, checkoutMode: 'FCFS' }],
    notes: [], images: [], categories: [],
  });
  console.log(JSON.stringify(res2));
  const { loadProducts } = await import('../lib/server-config');
  const products = await loadProducts(null, { tenantId: TENANT });
  const pr = products['prod_tenant_test_1'];
  console.log('read back: ' + (pr ? pr.name + ' ' + JSON.stringify(pr.priceCategories.map((c: any) => ({ size: c.size, price: c.price, liveStock: c.liveStock, mode: c.checkoutMode }))) : 'MISSING') +
    ' | tenant catalog size ' + Object.keys(products).length);
})().catch((e) => { console.error(e?.message || e); process.exit(1); });
