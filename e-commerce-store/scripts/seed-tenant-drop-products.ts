/**
 * TEST raffle + waitlist products in a non-default tenant's own catalog
 * (TENANCY.md phase 4), through the admin's catalog writer.
 *
 *   npx tsx scripts/seed-tenant-drop-products.ts [--draw-in=MINUTES] [--preorder-live] [tenantId]
 *
 *   Connect Test Raffle   RAFFLE, $30, 3 in stock, 3 winners per draw; its draw
 *                         date is MINUTES from now (default 15; negative = past).
 *   Connect Test Preorder instant-buy, $15, 5 in stock; NOT on sale (waitlist)
 *                         unless --preorder-live.
 * Idempotent on (tenant, slug); stock rows are never reset.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const p = join(process.cwd(), '.env.local');
if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';

const args = process.argv.slice(2);
const TENANT = args.find((a) => !a.startsWith('--')) || '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const drawIn = Number((args.find((a) => a.startsWith('--draw-in=')) || '--draw-in=15').split('=')[1]);
const preorderLive = args.includes('--preorder-live');

(async () => {
  const { writeProductToPostgres } = await import('../lib/catalog-write');
  const { DEFAULT_TENANT_ID } = await import('../lib/tenant-context');
  if (TENANT === DEFAULT_TENANT_ID) throw new Error('refusing to seed test data into the default store');
  const drawAt = new Date(Date.now() + drawIn * 60_000).toISOString();
  const raffle = await writeProductToPostgres(TENANT, {
    id: 'prod_tenant_test_3', name: 'Connect Test Raffle', slug: 'connect-test-raffle',
    tagline: 'Test raffle for verifying draws on this store (test mode).', desc: 'Test raffle (test mode).',
    isActive: true, isArchived: false, isUpcoming: false,
    checkoutMode: 'RAFFLE', productType: 'raffle', isRaffle: true,
    maxPerEmail: 1, maxPerCart: 1, totalInventory: 3, inventoryPerSize: { Standard: 3 },
    releaseEndsAt: drawAt,
    priceCategories: [{ size: 'Standard', price: 30, checkoutMode: 'RAFFLE', winnerTiers: '3' }],
    notes: [], images: [], categories: [],
  });
  const preorder = await writeProductToPostgres(TENANT, {
    id: 'prod_tenant_test_4', name: 'Connect Test Preorder', slug: 'connect-test-preorder',
    tagline: 'Test preorder for verifying the waitlist on this store (test mode).', desc: 'Test preorder (test mode).',
    isActive: preorderLive, isArchived: false, isUpcoming: !preorderLive,
    checkoutMode: 'FCFS', productType: 'fcfs', isRaffle: false,
    maxPerEmail: 2, maxPerCart: 2, totalInventory: 5, inventoryPerSize: { 'One Size': 5 },
    priceCategories: [{ size: 'One Size', price: 15, checkoutMode: 'FCFS' }],
    notes: [], images: [], categories: [],
  });
  console.log('raffle ' + JSON.stringify(raffle) + ' draw at ' + drawAt);
  console.log('preorder ' + JSON.stringify(preorder) + (preorderLive ? ' (ON SALE)' : ' (upcoming: waitlist)'));
})().catch((e) => { console.error(e?.message || e); process.exit(1); });
