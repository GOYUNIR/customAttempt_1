/**
 * Long-running fake catalog DB, seeded with one full-field product (Phase G).
 *
 *   npx tsx scripts/serve-fake-catalog.ts <port>
 *
 * Exists so a REAL Next dev server can point SUPABASE_URL at it and serve
 * /api/store from Postgres, proving the storefront renders what the new write
 * path saved — not merely that the reader returns it.
 */
import { startFakePostgrest } from './fake-postgrest';

async function main() {
  const port = Number(process.argv[2] || 54329);
  const db = await startFakePostgrest(port);
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + db.port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:' + db.port;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'roundtrip-key';
  process.env.USE_POSTGRES_PRIMARY = 'true';

  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { writeProductToPostgres } = await import('../lib/catalog-write');
  const tenantId = await ensureDefaultTenant();

  await writeProductToPostgres(tenantId, {
    id: 'prod-storefront',
    name: 'Storefront Proof Hoodie',
    slug: 'storefront-proof-hoodie',
    tagline: 'LIMITED DROP',
    desc: 'Rendered from Postgres.',
    priceCategories: [
      { size: 'M', price: 89.5, stripeId: 'price_m', checkoutMode: 'RAFFLE', maxPerEmail: 2 },
      { size: 'L', price: 94.25, stripeId: 'price_l', checkoutMode: 'FCFS' },
    ],
    isActive: true,
    isArchived: false,
    isUpcoming: false,
    isRaffle: true,
    checkoutMode: 'RAFFLE',
    productType: 'raffle',
    maxPerEmail: 3,
    maxPerCart: 2,
    maxRaffleAllocationLimit: 10,
    sortOrder: 7,
    notes: [{ text: 'Ships in 3 days' }],
    images: ['https://cdn.example.com/a.png'],
    crops: [{ x: 0.5, y: 0.5, w: 1, h: 1 }],
    totalInventory: 120,
    categories: ['outerwear', 'limited'],
    goLiveAt: '',
    releaseEndsAt: '',
    urgencyInStock: 'Selling fast',
    showUrgencyLine: true,
    soldOutBehavior: 'stay_visible',
  });

  console.log('FAKE_CATALOG_READY port=' + db.port + ' tenant=' + tenantId);
  console.log('tables: ' + Object.keys(db.tables).join(', '));
  setInterval(() => {}, 1 << 30); // stay alive for the dev server
}

main().catch((e) => { console.error('fake catalog failed:', e); process.exit(1); });
