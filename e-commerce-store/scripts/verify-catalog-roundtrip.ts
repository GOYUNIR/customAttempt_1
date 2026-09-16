/**
 * CATALOG ROUND-TRIP VERIFICATION (Phase G, step 4).
 *
 *   npm run verify:catalog
 *
 * Writes a product carrying the FULL admin-panel field set through the new
 * Postgres write path, reads it back through the storefront's own catalog
 * reader, and compares every field.
 *
 * The bar this has to clear: the previous backfill carried 4 real fields out
 * of 50 and "worked". Confirming a row exists proves nothing — this compares
 * the reconstructed product against what the admin panel actually saved.
 */
import { startFakePostgrest } from './fake-postgrest';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A product exercising every category of field the admin panel writes. */
function fullProduct(): Record<string, unknown> {
  return {
    id: 'prod-roundtrip',
    name: 'Round Trip Hoodie',
    slug: 'round-trip-hoodie',
    prefix: 'rth',
    tagline: 'LIMITED DROP',
    desc: 'A hoodie that proves the catalog round-trips.',
    priceCategories: [
      { size: 'M', price: 89.5, stripeId: 'price_m', checkoutMode: 'RAFFLE', winnerTiers: '3', maxPerEmail: 2, maxPerCart: 1, maxRaffleAllocationLimit: 5, commerceMode: 'drop', accessRule: { kind: 'public' }, billingRule: { kind: 'once' }, scheduleConfig: { cadence: 'weekly' } },
      { size: 'L', price: 94.25, stripeId: 'price_l', checkoutMode: 'FCFS', winnerTiers: '0' },
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
    notes: [{ text: 'Ships in 3 days' }, { text: 'True to size' }],
    images: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
    crops: [{ x: 0.5, y: 0.5, w: 1, h: 1 }, { x: 0.25, y: 0.75, w: 0.5, h: 0.5 }],
    totalInventory: 120,
    inventoryPerSize: { M: 70, L: 50 },
    categories: ['outerwear', 'limited'],
    winnerTiers: [3, 1],
    goLiveAt: '2026-10-01 18:00',
    releaseEndsAt: '2026-10-03 18:00',
    commerceMode: 'drop',
    accessRule: { kind: 'public' },
    billingRule: { kind: 'once' },
    scheduleConfig: { cadence: 'weekly' },
    customDropSchedule: { dayOfWeek: 5, hour: 18 },
    sizeConfigs: { M: { customDropSchedule: { dayOfWeek: 6, hour: 12 } } },
    soldOutBehavior: 'stay_visible',
    soldOutAt: '',
    soldOutArchiveDelayHours: 24,
    urgencyInStock: 'Selling fast',
    urgencySoldOut: 'Gone',
    showUrgencyLine: true,
    showStatusLine: true,
    showNotesSection: true,
    showMixedRibbon: false,
    mixedFormatRibbon: 'Mixed drop',
    statusLive: 'Live now',
    statusArchived: 'Archived',
    samplerSizes: ['M'],
    deliveryIncentiveEnabled: true,
    deliveryIncentiveCreditCents: 500,
    deliveryIncentiveCodePrefix: 'SHIP',
    deliveryIncentiveExpiresDays: 30,
    deliveryIncentiveNeverExpires: false,
    deliveryIncentiveMinOrderSubtotalCents: 2000,
    deliveryIncentiveEligibleSizes: ['M', 'L'],
    deliveryIncentiveEligibleProductSlugs: ['round-trip-hoodie'],
  };
}

async function main() {
  const db = await startFakePostgrest();
  process.env.SUPABASE_URL = 'http://127.0.0.1:' + db.port;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:' + db.port;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'roundtrip-key';
  process.env.USE_POSTGRES_PRIMARY = 'true';

  console.log('\nCatalog round trip - full field set\n' + '='.repeat(56));

  const { writeProductToPostgres } = await import('../lib/catalog-write');
  const { readCatalogFromPostgres } = await import('../lib/postgres-catalog-read');

  const source = fullProduct();
  const tenantId = '00000000-0000-4000-8000-0000000000aa';
  const written = await writeProductToPostgres(tenantId, source);
  check(written.ok === true, 'product written through the port', written.error || '');
  check(written.variantCount === 2, 'both variants written', String(written.variantCount));

  const catalog = await readCatalogFromPostgres(tenantId);
  check(Boolean(catalog), 'catalog read back');
  const raw = (catalog?.productsRaw?.[0] || null) as Record<string, unknown> | null;
  check(Boolean(raw), 'the product is present in productsRaw');
  if (!raw) { db.close(); console.log('\n' + fail + ' FAILURE(S)\n'); process.exit(1); }

  const scalars: Array<[string, unknown, unknown]> = [
    ['id', raw.id, source.id],
    ['name', raw.name, source.name],
    ['slug', raw.slug, source.slug],
    ['desc', raw.desc, source.desc],
    ['tagline', raw.tagline, source.tagline],
    ['prefix', raw.prefix, source.prefix],
    ['isActive', raw.isActive, true],
    ['isArchived', raw.isArchived, false],
    ['isUpcoming', raw.isUpcoming, false],
    ['checkoutMode', raw.checkoutMode, 'RAFFLE'],
    ['isRaffle', raw.isRaffle, true],
    ['productType', raw.productType, source.productType],
    ['maxPerEmail', raw.maxPerEmail, source.maxPerEmail],
    ['maxPerCart', raw.maxPerCart, source.maxPerCart],
    ['maxRaffleAllocationLimit', raw.maxRaffleAllocationLimit, source.maxRaffleAllocationLimit],
    ['sortOrder', raw.sortOrder, source.sortOrder],
    ['goLiveAt', raw.goLiveAt, source.goLiveAt],
    ['releaseEndsAt', raw.releaseEndsAt, source.releaseEndsAt],
    ['totalInventory', raw.totalInventory, source.totalInventory],
    ['soldOutBehavior', raw.soldOutBehavior, source.soldOutBehavior],
    ['soldOutArchiveDelayHours', raw.soldOutArchiveDelayHours, source.soldOutArchiveDelayHours],
    ['urgencyInStock', raw.urgencyInStock, source.urgencyInStock],
    ['showUrgencyLine', raw.showUrgencyLine, source.showUrgencyLine],
    ['mixedFormatRibbon', raw.mixedFormatRibbon, source.mixedFormatRibbon],
    ['statusLive', raw.statusLive, source.statusLive],
    ['commerceMode', raw.commerceMode, source.commerceMode],
    ['deliveryIncentiveEnabled', raw.deliveryIncentiveEnabled, source.deliveryIncentiveEnabled],
    ['deliveryIncentiveCreditCents', raw.deliveryIncentiveCreditCents, source.deliveryIncentiveCreditCents],
    ['deliveryIncentiveCodePrefix', raw.deliveryIncentiveCodePrefix, source.deliveryIncentiveCodePrefix],
  ];
  for (const [field, actual, expected] of scalars) {
    check(same(actual, expected), 'field: ' + field, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
  }

  const deep: Array<[string, unknown, unknown]> = [
    ['notes', raw.notes, source.notes],
    ['images', raw.images, source.images],
    ['crops', raw.crops, source.crops],
    ['categories', raw.categories, source.categories],
    ['winnerTiers', raw.winnerTiers, source.winnerTiers],
    ['inventoryPerSize', raw.inventoryPerSize, source.inventoryPerSize],
    ['accessRule', raw.accessRule, source.accessRule],
    ['billingRule', raw.billingRule, source.billingRule],
    ['scheduleConfig', raw.scheduleConfig, source.scheduleConfig],
    ['customDropSchedule', raw.customDropSchedule, source.customDropSchedule],
    ['samplerSizes', raw.samplerSizes, source.samplerSizes],
    ['deliveryIncentiveEligibleSizes', raw.deliveryIncentiveEligibleSizes, source.deliveryIncentiveEligibleSizes],
  ];
  for (const [field, actual, expected] of deep) {
    check(same(actual, expected), 'deep: ' + field, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
  }

  const cats = (raw.priceCategories || []) as Array<Record<string, unknown>>;
  check(cats.length === 2, 'both price categories round-trip', String(cats.length));
  const m = cats.find((c) => c.size === 'M');
  check(Boolean(m), 'size M present');
  check(m?.price === 89.5, 'size M price', String(m?.price));
  check(m?.checkoutMode === 'RAFFLE', 'size M checkout mode', String(m?.checkoutMode));
  check(m?.maxPerEmail === 2, 'size M per-size purchase limit', String(m?.maxPerEmail));
  check(m?.stripeId === 'price_m', 'size M stripe price id', String(m?.stripeId));
  check(same(m?.accessRule, { kind: 'public' }), 'size M access rule', JSON.stringify(m?.accessRule));
  const l = cats.find((c) => c.size === 'L');
  check(l?.checkoutMode === 'FCFS', 'size L is FCFS (per-size mode differs from product)', String(l?.checkoutMode));

  const sc = (raw.sizeConfigs || {}) as Record<string, { customDropSchedule?: unknown }>;
  // Keys are LOWERCASED by sizeConfigKey(). The admin API normalizes the same
  // way (normalizeSizeConfigs), so Redis stores { m: ... } too — asserting 'M'
  // here was the harness being wrong, not the round trip.
  check(same(sc.m?.customDropSchedule, { dayOfWeek: 6, hour: 12 }), 'per-size custom drop schedule (key normalized to lower case)', JSON.stringify(sc));
  check(sc.M === undefined, 'size keys are normalized, not stored raw');

  db.close();
  console.log('='.repeat(56));
  console.log(fail === 0 ? 'CATALOG ROUND TRIP VERIFIED - full field set\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
