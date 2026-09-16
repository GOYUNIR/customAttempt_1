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

  // A tenant_store_config row must exist: since the SEV-2 fix,
  // readCatalogFromPostgres REFUSES a tenant that has products but no config
  // row rather than silently serving defaults. Production has one; this
  // fixture needs one too, or it tests a state that can no longer occur.
  db.tables['tenant_store_config'] = [
    { tenant_id: tenantId, config: {}, schedule_override: {}, social_override: {} },
  ];
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

  // ---------------------------------------------------------------------
  // LIFECYCLE VISIBILITY (difference 1).
  //
  // The reader used to query `status: eq('live')`. `status` is derived from
  // the flags (statusFromFlags), so an upcoming product is 'draft' and an
  // archived one is 'archived' — BOTH were silently invisible to the
  // storefront, and applyLifecycle() never saw the upcoming one, so its
  // shouldGoLive transition could never fire. The Redis path loads every
  // product unfiltered. These assertions pin that contract.
  // ---------------------------------------------------------------------
  console.log(String.fromCharCode(10) + "Lifecycle visibility - upcoming and archived products" + String.fromCharCode(10) + '='.repeat(56));

  const upcoming = {
    id: 'prod-upcoming',
    name: 'Upcoming Drop',
    slug: 'upcoming-drop',
    desc: 'Scheduled, not yet live.',
    priceCategories: [{ size: 'OS', price: 120, stripeId: 'price_up', checkoutMode: 'RAFFLE' }],
    isActive: false,
    isUpcoming: true,
    isArchived: false,
    checkoutMode: 'RAFFLE',
    goLiveAt: '2099-01-01 10:00',
    totalInventory: 25,
    inventoryPerSize: { OS: 25 },
  };
  const archived = {
    id: 'prod-archived',
    name: 'Archived Drop',
    slug: 'archived-drop',
    desc: 'Past drop, kept for the archive shelf.',
    priceCategories: [{ size: 'OS', price: 60, stripeId: 'price_arch', checkoutMode: 'FCFS' }],
    isActive: false,
    isUpcoming: false,
    isArchived: true,
    checkoutMode: 'FCFS',
    totalInventory: 0,
    inventoryPerSize: { OS: 0 },
  };
  const wUp = await writeProductToPostgres(tenantId, upcoming);
  const wArch = await writeProductToPostgres(tenantId, archived);
  check(wUp.ok === true, 'upcoming product written', wUp.error || '');
  check(wArch.ok === true, 'archived product written', wArch.error || '');

  // Confirm the DB really stored them under the statuses that used to be
  // filtered out — otherwise this test would pass for the wrong reason.
  const statusRows = (db.tables['products'] || []) as Array<Record<string, unknown>>;
  const statusBySlug = new Map(statusRows.map((r) => [String(r.slug), String(r.status)]));
  check(statusBySlug.get('upcoming-drop') === 'draft', "upcoming product is stored as status='draft'", String(statusBySlug.get('upcoming-drop')));
  check(statusBySlug.get('archived-drop') === 'archived', "archived product is stored as status='archived'", String(statusBySlug.get('archived-drop')));

  const catalog2 = await readCatalogFromPostgres(tenantId);
  const bySlug = new Map(
    ((catalog2?.productsRaw || []) as Array<Record<string, unknown>>).map((r) => [String(r.slug), r]),
  );
  check(bySlug.size === 3, 'all three products are visible to the storefront reader', 'saw ' + bySlug.size + ': ' + [...bySlug.keys()].join(', '));

  const up = bySlug.get('upcoming-drop');
  check(Boolean(up), 'UPCOMING product reaches the storefront reader (was dropped by status=live)');
  check(up?.isUpcoming === true, 'upcoming: isUpcoming is true', JSON.stringify(up?.isUpcoming));
  check(up?.isActive === false, 'upcoming: isActive is false', JSON.stringify(up?.isActive));
  check(up?.isArchived === false, 'upcoming: isArchived is false', JSON.stringify(up?.isArchived));
  check(up?.goLiveAt === '2099-01-01 10:00', 'upcoming: goLiveAt survives for applyLifecycle to compare against', JSON.stringify(up?.goLiveAt));

  const arch = bySlug.get('archived-drop');
  check(Boolean(arch), 'ARCHIVED product reaches the storefront reader (was dropped by status=archived)');
  check(arch?.isArchived === true, 'archived: isArchived is true', JSON.stringify(arch?.isArchived));
  check(arch?.isUpcoming === false, 'archived: isUpcoming is false', JSON.stringify(arch?.isUpcoming));

  // The live product must still be live — the fix widened the query, it did
  // not blur the lifecycle flags.
  const live = bySlug.get('round-trip-hoodie');
  check(live?.isActive === true && live?.isUpcoming === false && live?.isArchived === false, 'live product still reads as live', JSON.stringify({ a: live?.isActive, u: live?.isUpcoming, r: live?.isArchived }));

  // ---------------------------------------------------------------------
  // DUPLICATE OPTION LABELS (difference 2).
  //
  // product_variants is unique on (product_id, option_label), so two price
  // categories sharing a size upsert onto each other and the last one wins.
  // The write path used to count loop iterations, so it reported a
  // variantCount that did not match the rows that existed -- the merge was
  // invisible to every caller. It now counts distinct labels and names the
  // collisions.
  // ---------------------------------------------------------------------
  console.log(String.fromCharCode(10) + "Duplicate option labels are reported, not merged in silence" + String.fromCharCode(10) + '='.repeat(56));

  const dupeProduct = {
    id: 'prod-dupe',
    name: 'Duplicate Label Drop',
    slug: 'duplicate-label-drop',
    desc: 'Two categories share one option label.',
    priceCategories: [
      { size: 'Standard', price: 149, stripeId: 'price_hi', checkoutMode: 'RAFFLE' },
      { size: 'Standard', price: 19, stripeId: 'price_lo', checkoutMode: 'FCFS' },
      { size: 'Large', price: 60, stripeId: 'price_lg', checkoutMode: 'FCFS' },
    ],
    isActive: true,
    isUpcoming: false,
    isArchived: false,
    checkoutMode: 'RAFFLE',
    totalInventory: 5,
  };
  const wDupe = await writeProductToPostgres(tenantId, dupeProduct);
  check(wDupe.ok === true, 'duplicate-label product written', wDupe.error || '');
  check(wDupe.variantCount === 2, 'variantCount reports DISTINCT rows (2), not categories submitted (3)', String(wDupe.variantCount));
  const dupes = wDupe.duplicateLabels || [];
  check(dupes.length === 1, 'the collision is reported', JSON.stringify(dupes));
  check(dupes[0]?.label === 'Standard' && dupes[0]?.count === 2, "the collision names 'Standard' x2", JSON.stringify(dupes[0]));

  // The reported count must match reality, not just sound plausible.
  const dupeRow = (db.tables['products'] || []).find((r) => r.slug === 'duplicate-label-drop');
  const dupeVariants = (db.tables['product_variants'] || []).filter((v) => v.product_id === dupeRow?.id);
  check(dupeVariants.length === 2, 'the database really holds 2 rows, matching variantCount', String(dupeVariants.length));
  const survivor = dupeVariants.find((v) => v.option_label === 'Standard');
  check(survivor?.price_cents === 1900, 'the LAST category won (19.00), confirming the merge direction reported to the operator', String(survivor?.price_cents));

  // A product with no duplicates must not be flagged.
  check((written.duplicateLabels || []).length === 0, 'a clean product reports no collisions', JSON.stringify(written.duplicateLabels));

  db.close();
  console.log('='.repeat(56));
  console.log(fail === 0 ? 'CATALOG ROUND TRIP VERIFIED - full field set\n' : fail + ' FAILURE(S)\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
