import { NextResponse } from 'next/server';
import {
  aggregateLiveInventoryByProduct,
  createRedisClient,
  findLiveInventoryForProduct,
  getCatalogArchiveRecords,
  getFallbackStoreProducts,
  listLiveStates,
  safeParseRedisItem,
} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET() {
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
      const fallback = Object.values(getFallbackStoreProducts());
      const activeDrops = sortProducts(fallback)
        .filter((p) => p.isActive !== false && !p.isArchived && !p.isUpcoming)
        .map((p) => ({
          id: p.id,
          name: p.name,
          tagline: p.tagline || 'LIMITED DROP',
          desc: p.desc || '',
          slug: p.slug,
          image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
          soldOut: false,
          inventoryRemaining: Number(p.totalInventory || 0),
        }));
      const upcomingDrops = sortProducts(fallback)
        .filter((p) => p.isUpcoming && !p.isArchived)
        .map((p) => ({
          name: p.name,
          status: 'Upcoming',
          eta: p.tagline || 'Coming soon',
          goLiveAt: p.goLiveAt || '',
          image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
          description: p.desc || '',
          slug: p.slug,
        }));
      const archiveScents = sortProducts(fallback)
        .filter((p) => p.isArchived)
        .map((p) => ({
          name: p.name,
          status: 'Archived',
          image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
          description: p.desc || '',
          availableFrom: 'Previously available',
          slug: p.slug,
          productId: p.id,
          // No live state exists in fallback mode, so follow the storefront rule:
          // only sold out when the product itself is flagged sold out.
          soldOut: p.soldOut === true,
        }));

      return NextResponse.json({
        activeDrops,
        upcomingDrops,
        archiveScents,
        archivedProductIds: archiveScents.map((item) => item.productId),
        soldOutProductIds: [],
        notesByProductId: {},
        availableFromByProductId: {},
        records: [],
        fromFallback: true,
      });
    }

    const archived = await getCatalogArchiveRecords(redis);
    const archivedProductIds = archived.map((r) => r.productId);
    const catalogConfig = safeParseRedisItem<any>(await redis.get('store:catalog_config')) || {};
    const configuredUpcoming = Array.isArray(catalogConfig.upcomingDrops) ? catalogConfig.upcomingDrops : [];
    const configuredArchive = Array.isArray(catalogConfig.archiveScents) ? catalogConfig.archiveScents : [];
    const liveStates = await listLiveStates(redis);
    const liveStatesByProduct = aggregateLiveInventoryByProduct(liveStates);

    let allProducts: any[] = [];
    const allRaw = await redis.hgetall('store:products');
    if (allRaw) {
      for (const value of Object.values(allRaw)) {
        const product = safeParseRedisItem<any>(value);
        if (product) allProducts.push(product);
      }
    }

    if (allProducts.length === 0) {
      allProducts = Object.values(getFallbackStoreProducts());
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
      const soldOut = totalInventory > 0 && inventoryRemaining <= 0;
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

    return NextResponse.json({
      activeDrops,
      upcomingDrops,
      archiveScents,
      archivedProductIds,
      soldOutProductIds: sortedProducts.filter((item) => item.soldOut === true).map((item) => item.id),
      notesByProductId: {},
      availableFromByProductId: {},
      records: archived,
    });
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
