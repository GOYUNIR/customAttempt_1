import { NextResponse } from 'next/server';
import {
  aggregateLiveInventoryByProduct,
  createRedisClient,
  findLiveInventoryForProduct,
  getCatalogArchiveRecords,
  listLiveStates,
  safeParseRedisItem,
  STORE_CONFIG_KEY,
  PRODUCTS_KEY,
  OVERRIDES_KEY,
  OVERRIDE_SCHEDULE_FIELD,
} from '@/lib/server-config';
import { withTtlCache } from '@/lib/ttl-cache';
import { dropTimestampToMs, formatStoreWallClock } from '@/lib/drop-timestamps';
import { resolveNextRaffleAnchorMs, normalizeCategories } from '@/lib/storefront-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const payload = await withTtlCache('catalog:status:v1', 15_000, () => buildCatalogPayload());
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('[catalog/status] Error:', err?.message || err);
    return NextResponse.json(
      {
        error: 'Catalog unavailable.',
        activeDrops: [],
        upcomingDrops: [],
        archiveScents: [],
        sectionOrder: [],
        categories: [],
        archivedProductIds: [],
        soldOutProductIds: [],
        notesByProductId: {},
        availableFromByProductId: {},
        records: [],
      },
      { status: 500 },
    );
  }
}

async function buildCatalogPayload() {
  try {
    const redis = createRedisClient();
    // Catalog groupings are stored inside store:config.catalogPreview (single
    // source of truth) — there is no separate `store:catalog_config` key.
    // Read early: the store timezone below comes from the same config blob.
    const storeConfig = safeParseRedisItem<any>(redis ? await redis.get(STORE_CONFIG_KEY) : null) || {};
    // Drop timestamps are naive wall-clock strings set in the STORE's
    // timezone. Parse them as such so the catalog's go-live logic agrees with
    // the product page countdown and the server draw engine.
    const storeTimezone = String(
      storeConfig?.dropSchedule?.timezone ||
      GOYUNIR_STORE_SUITE.dropSchedule?.timezone ||
      'America/Los_Angeles',
    );
    const toMs = (value: unknown) => dropTimestampToMs(value, storeTimezone);
    const sortProducts = (items: any[]) =>
      [...items].sort(
        (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)),
      );

    if (!redis) {
      // No Redis configured and nothing has been seeded yet → start with zero
      // products. Operators publish content via /admin (Seed Defaults or Add Product).
      return {
        activeDrops: [],
        upcomingDrops: [],
        archiveScents: [],
        sectionOrder: ['upcoming', 'archive', 'live'],
        categories: normalizeCategories(GOYUNIR_STORE_SUITE.catalog?.categories),
        archivedProductIds: [],
        soldOutProductIds: [],
        notesByProductId: {},
        availableFromByProductId: {},
        records: [],
        storeTimezone,
        fromFallback: true,
      };
    }

    const archived = await getCatalogArchiveRecords(redis);
    const archivedProductIds = archived.map((r) => r.productId);
    const catalogPreview = storeConfig.catalogPreview || {};
    const configuredUpcoming = Array.isArray(catalogPreview.upcomingDrops) ? catalogPreview.upcomingDrops : [];
    const configuredArchive = Array.isArray(catalogPreview.archiveScents) ? catalogPreview.archiveScents : [];
    // Admin-configurable /catalog section order (Settings → Catalog). Default:
    // live at the BOTTOM. Unknown ids are dropped and missing ones appended.
    const rawOrder = storeConfig.catalog?.sectionOrder;
    const sectionOrder = Array.isArray(rawOrder)
      ? [...new Set([...rawOrder.map(String), 'live', 'upcoming', 'archive'].filter((s) => ['live', 'upcoming', 'archive'].includes(s)))]
      : ['upcoming', 'archive', 'live'];
    // Admin-managed product categories (Settings → Catalog → Categories).
    const categories = normalizeCategories(storeConfig.catalog?.categories ?? GOYUNIR_STORE_SUITE.catalog?.categories);
    const liveStates = await listLiveStates(redis);
    const liveStatesByProduct = aggregateLiveInventoryByProduct(liveStates);
    // Global drop-schedule override merged over the static config — used to
    // compute `nextReleaseEndsAt` exactly like /api/store so the catalog tile
    // timers agree with the product page and the draw engine.
    const scheduleOverride = safeParseRedisItem<any>(redis ? await redis.hget(OVERRIDES_KEY, OVERRIDE_SCHEDULE_FIELD) : null) || {};
    const globalSchedule = { ...GOYUNIR_STORE_SUITE.dropSchedule, ...(storeConfig?.dropSchedule || {}), ...scheduleOverride };

    const allProducts: any[] = [];
    const allRaw = await redis.hgetall(PRODUCTS_KEY);
    if (allRaw) {
      for (const value of Object.values(allRaw)) {
        const product = safeParseRedisItem<any>(value);
        if (product) allProducts.push(product);
      }
    }

    const now = Date.now();
    // Same checkout-mode normalization as /api/store so the catalog and the
    // product page always agree on Raffle vs FCFS.
    const normalizeMode = (p: any): 'RAFFLE' | 'FCFS' => {
      const mode = String(p?.checkoutMode || '').toUpperCase();
      if (mode === 'FCFS') return 'FCFS';
      if (mode === 'RAFFLE') return 'RAFFLE';
      if (p?.isRaffle === false || String(p?.productType || '').toLowerCase() === 'fcfs') return 'FCFS';
      return 'RAFFLE';
    };
    const sortedProducts = sortProducts(allProducts).map((product) => {
      const inventory = findLiveInventoryForProduct(liveStatesByProduct, product, liveStates);
      const inventoryRemaining = inventory
        ? inventory.inventoryRemaining
        : Math.max(0, Number(product.totalInventory || 0));
      const totalInventory = inventory
        ? inventory.totalInventory
        : Math.max(0, Number(product.totalInventory || 0));
      // Sold out when (a) inventory was configured and remaining hit zero, or
      // (b) no inventory is configured but the operator chose "stay visible as
      // social proof" — a 0-stock active product is a sold-out placeholder.
      const soldOut =
        totalInventory > 0
          ? inventoryRemaining <= 0
          : product.soldOutBehavior === 'stay_visible';
      const goLiveAtMs = toMs(product.goLiveAt);
      const soldOutAtMs = toMs(product.soldOutAt);
      const shouldGoLive = product.isUpcoming && goLiveAtMs !== null && now >= goLiveAtMs;
      const shouldArchiveFromSoldOut = soldOut && product.soldOutBehavior === 'archive_now';
      const shouldArchiveAfterDelay =
        soldOut &&
        product.soldOutBehavior === 'archive_after_delay' &&
        soldOutAtMs !== null &&
        now >= soldOutAtMs + Math.max(0, Number(product.soldOutArchiveDelayHours || 0)) * 60 * 60 * 1000;

      const lifecycleProduct = {
        ...product,
        inventoryRemaining,
        totalInventory,
        soldOut,
        isUpcoming: shouldGoLive ? false : product.isUpcoming,
        isArchived: shouldArchiveFromSoldOut || shouldArchiveAfterDelay ? true : product.isArchived,
        isActive: shouldGoLive ? true : product.isActive,
      };

      // Effective countdown anchor — the next scheduled draw for recurring
      // raffles whose timer ended with inventory remaining (the "new raffle"
      // timer the tiles should show instead of "Until sold out").
      let nextReleaseEndsAt = String(product.releaseEndsAt || '');
      try {
        const effectiveSchedule = { ...GOYUNIR_STORE_SUITE.dropSchedule, ...(globalSchedule || {}), ...(product.customDropSchedule || {}) };
        const nextAnchorMs = resolveNextRaffleAnchorMs(lifecycleProduct, effectiveSchedule as any, now);
        if (nextAnchorMs !== null) nextReleaseEndsAt = formatStoreWallClock(nextAnchorMs, storeTimezone);
      } catch {}

      return { ...lifecycleProduct, nextReleaseEndsAt };
    });

    // Lookup by slug OR name so static `catalogPreview` entries can inherit the
    // REAL product's Raffle/FCFS mode, slug, go-live date and sold-out state —
    // otherwise configured upcoming/archive cards silently missed the tags that
    // product-derived cards always show (the "inconsistent catalog" bug).
    const productLookup = new Map<string, any>();
    for (const p of sortedProducts) {
      if (p.slug) productLookup.set(String(p.slug).toLowerCase(), p);
      if (p.name) productLookup.set(String(p.name).toLowerCase(), p);
    }
    const enrichConfigured = (item: any) => {
      const key = String(item?.slug || item?.name || '').toLowerCase();
      const match = key ? productLookup.get(key) : null;
      if (!match) return item;
      return {
        ...item,
        slug: item.slug || match.slug || match.name,
        goLiveAt: item.goLiveAt || match.goLiveAt || '',
        checkoutMode: normalizeMode(match),
        isRaffle: normalizeMode(match) === 'RAFFLE',
      };
    };
    const configuredUpcomingEnriched = configuredUpcoming.map(enrichConfigured);
    const configuredArchiveEnriched = configuredArchive.map(enrichConfigured);

    const activeDrops = sortedProducts
      .filter((p) => p.isActive && !p.isArchived && !p.isUpcoming && !archivedProductIds.includes(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        tagline: p.tagline || 'LIMITED DROP',
        desc: p.desc || '',
        slug: p.slug,
        image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
        soldOut: p.soldOut === true,
        inventoryRemaining: p.inventoryRemaining,
        checkoutMode: normalizeMode(p),
        isRaffle: normalizeMode(p) === 'RAFFLE',
        goLiveAt: p.goLiveAt || '',
        releaseEndsAt: p.releaseEndsAt || '',
        nextReleaseEndsAt: p.nextReleaseEndsAt || p.releaseEndsAt || '',
        categories: Array.isArray(p.categories) ? p.categories.map(String) : [],
      }));

    // Never list a product in BOTH live drops and upcoming. Products that
    // transitioned live (their goLiveAt passed) are already in activeDrops,
    // so drop any stale configured-upcoming entry that points at the same slug.
    const activeSlugs = new Set(activeDrops.map((d: any) => String(d.slug || '').toLowerCase()));

    const upcomingFromProducts = sortedProducts
      .filter((p) => p.isUpcoming && !p.isArchived)
      .map((p) => ({
        name: p.name,
        status: 'Upcoming',
        eta: p.goLiveAt ? `Opens ${p.goLiveAt}` : p.tagline || 'Coming soon',
        goLiveAt: p.goLiveAt || '',
        image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
        description: p.desc || '',
        slug: p.slug,
        checkoutMode: normalizeMode(p),
        isRaffle: normalizeMode(p) === 'RAFFLE',
      }));

    // Never list a product that is (or just became) archived in "Upcoming".
    const archivedProductSlugs = new Set(
      sortedProducts
        .filter((p) => p.isArchived || archivedProductIds.includes(p.id))
        .map((p) => String(p.slug || p.name || '').toLowerCase()),
    );

    const upcomingDrops = sortProducts(
      [...upcomingFromProducts, ...configuredUpcomingEnriched]
        .filter((item: any) => !activeSlugs.has(String(item.slug || item.name || '').toLowerCase()))
        .filter((item: any) => !archivedProductSlugs.has(String(item.slug || item.name || '').toLowerCase()))
        .filter(
          (item: any, index: number, all: any[]) =>
            all.findIndex((v: any) => String(v.slug || v.name) === String(item.slug || item.name)) === index,
        ),
    );

    const archiveFromProducts = sortedProducts
      .filter((p) => p.isArchived || archivedProductIds.includes(p.id))
      .map((p) => ({
        name: p.name,
        status: 'Archived',
        image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
        description: p.desc || p.notes?.[0]?.text || '',
        availableFrom: p.availableFrom || 'Previously available',
        slug: p.slug,
        productId: p.id,
        soldOut: p.soldOut === true,
        checkoutMode: normalizeMode(p),
        isRaffle: normalizeMode(p) === 'RAFFLE',
      }));

    const archiveScents = sortProducts(
      [...archiveFromProducts, ...configuredArchiveEnriched].filter(
        (item: any, index: number, all: any[]) =>
          all.findIndex((v: any) => String(v.slug || v.name) === String(item.slug || item.name)) === index,
      ),
    );

    return {
      activeDrops,
      upcomingDrops,
      archiveScents,
      sectionOrder,
      categories,
      archivedProductIds,
      soldOutProductIds: sortedProducts.filter((item) => item.soldOut === true).map((item) => item.id),
      notesByProductId: {},
      availableFromByProductId: {},
      records: archived,
      storeTimezone,
    };
  } catch (err: any) {
    console.error('[catalog/status] Error:', err?.message || err);
    return {
      error: 'Catalog unavailable.',
      activeDrops: [],
      upcomingDrops: [],
      archiveScents: [],
      sectionOrder: [],
      categories: [],
      archivedProductIds: [],
      soldOutProductIds: [],
      notesByProductId: {},
      availableFromByProductId: {},
      records: [],
    };
  }
}
