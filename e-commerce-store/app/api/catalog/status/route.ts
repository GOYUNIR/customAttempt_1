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
} from '@/lib/server-config';
import { withTtlCache } from '@/lib/ttl-cache';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const payload = await withTtlCache('catalog:status:v1', 15_000, () => buildCatalogPayload());
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('[catalog/status] Error:', err);
    return NextResponse.json(
      {
        error: err?.message || 'Unknown error',
        activeDrops: [],
        upcomingDrops: [],
        archiveScents: [],
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
    const toMs = (value: unknown) => {
      const parsed = typeof value === 'string' && value ? new Date(value).getTime() : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    };
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
        archivedProductIds: [],
        soldOutProductIds: [],
        notesByProductId: {},
        availableFromByProductId: {},
        records: [],
        fromFallback: true,
      };
    }

    const archived = await getCatalogArchiveRecords(redis);
    const archivedProductIds = archived.map((r) => r.productId);
    // Catalog groupings are stored inside store:config.catalogPreview (single
    // source of truth) — there is no separate `store:catalog_config` key.
    const storeConfig = safeParseRedisItem<any>(await redis.get(STORE_CONFIG_KEY)) || {};
    const catalogPreview = storeConfig.catalogPreview || {};
    const configuredUpcoming = Array.isArray(catalogPreview.upcomingDrops) ? catalogPreview.upcomingDrops : [];
    const configuredArchive = Array.isArray(catalogPreview.archiveScents) ? catalogPreview.archiveScents : [];
    const liveStates = await listLiveStates(redis);
    const liveStatesByProduct = aggregateLiveInventoryByProduct(liveStates);

    const allProducts: any[] = [];
    const allRaw = await redis.hgetall(PRODUCTS_KEY);
    if (allRaw) {
      for (const value of Object.values(allRaw)) {
        const product = safeParseRedisItem<any>(value);
        if (product) allProducts.push(product);
      }
    }

    const now = Date.now();
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
      return {
        ...product,
        inventoryRemaining,
        totalInventory,
        soldOut,
        isUpcoming: shouldGoLive ? false : product.isUpcoming,
        isArchived: shouldArchiveFromSoldOut || shouldArchiveAfterDelay ? true : product.isArchived,
        isActive: shouldGoLive ? true : product.isActive,
      };
    });

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
      }));

    const upcomingDrops = sortProducts(
      [...upcomingFromProducts, ...configuredUpcoming]
        .filter((item: any) => !activeSlugs.has(String(item.slug || item.name || '').toLowerCase()))
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
      }));

    const archiveScents = sortProducts(
      [...archiveFromProducts, ...configuredArchive].filter(
        (item: any, index: number, all: any[]) =>
          all.findIndex((v: any) => String(v.slug || v.name) === String(item.slug || item.name)) === index,
      ),
    );

    return {
      activeDrops,
      upcomingDrops,
      archiveScents,
      archivedProductIds,
      soldOutProductIds: sortedProducts.filter((item) => item.soldOut === true).map((item) => item.id),
      notesByProductId: {},
      availableFromByProductId: {},
      records: archived,
    };
  } catch (err: any) {
    console.error('[catalog/status] Error:', err);
    return {
      error: err?.message || 'Unknown error',
      activeDrops: [],
      upcomingDrops: [],
      archiveScents: [],
      archivedProductIds: [],
      soldOutProductIds: [],
      notesByProductId: {},
      availableFromByProductId: {},
      records: [],
    };
  }
}
