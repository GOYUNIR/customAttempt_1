import { NextResponse } from 'next/server';
import {
  createRedisClient,
  getCatalogArchiveRecords,
  archiveProductToCatalog,
  unarchiveProductFromCatalog,
  getLiveProductState,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { resolveProductSchedule, scheduledDateToTimestamp, getAvailableSizes } from '@/lib/storefront-config';
import { getWinnerCountForDraw } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

// The size used to track a product's live active/inventory state. Since
// most drops only sell one size, we key live state off the first
// configured size — if you run true dual-size inventory, extend this.
function primarySize() {
  return getAvailableSizes(GOYUNIR_STORE_SUITE)[0] || '50ml';
}

export async function GET() {
  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({
      activeDrops: GOYUNIR_STORE_SUITE.productCatalog.filter((p) => p.isActive !== false),
      upcomingDrops: GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
      archiveScents: GOYUNIR_STORE_SUITE.catalogPreview.archiveScents,
      archivedProductIds: [],
      liveState: {},
    });
  }

  const now = Date.now();
  const size = primarySize();
  const archivedRecords = await getCatalogArchiveRecords(redis);
  const archivedIds = new Set(archivedRecords.map((r) => r.productId));
  const archiveNotesById = new Map(archivedRecords.map((r) => [r.productId, r.notes || '']));

  // Load/seed live state for every product and run scheduled archive checks.
  const liveStateByProductId: Record<string, any> = {};
  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
    const live = await getLiveProductState(redis, product.id, size, {
      isActive: product.isActive !== false,
      totalInventory: product.totalInventory ?? product.maxRaffleAllocationLimit ?? 10,
      winnersPerDraw: product.winnerTiers?.length ? product.winnerTiers : [product.maxRaffleAllocationLimit ?? 1],
    });
    liveStateByProductId[product.id] = live;

    const schedule = resolveProductSchedule(GOYUNIR_STORE_SUITE, product);
    if (product.scheduledArchiveAt && !archivedIds.has(product.id)) {
      const ts = scheduledDateToTimestamp(product.scheduledArchiveAt, schedule.timezone);
      if (now >= ts) {
        await archiveProductToCatalog(redis, {
          productId: product.id,
          name: product.name,
          image: product.catalogImage || `/images/${product.prefix}_1.jpg`,
          description: product.desc,
          availableFrom: 'See product schedule',
          archivedAt: new Date().toISOString(),
        });
        archivedIds.add(product.id);
      }
    }
    if (product.scheduledUnarchiveAt && archivedIds.has(product.id)) {
      const ts = scheduledDateToTimestamp(product.scheduledUnarchiveAt, schedule.timezone);
      if (now >= ts) {
        await unarchiveProductFromCatalog(redis, product.id);
        archivedIds.delete(product.id);
      }
    }
  }

  // "Active" now respects the LIVE isActive flag (admin-editable), not the
  // static config file — this is what makes the admin active/hidden toggle
  // actually work without a redeploy.
  const activeDrops = GOYUNIR_STORE_SUITE.productCatalog.filter(
    (p) => liveStateByProductId[p.id]?.isActive !== false && !archivedIds.has(p.id),
  );

  const dynamicArchive = (await getCatalogArchiveRecords(redis))
    .filter((r) => archivedIds.has(r.productId))
    .map((r) => {
      const product = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.id === r.productId);
      const image =
        r.image ||
        product?.catalogImage ||
        (product ? `/images/${product.prefix}_1.jpg` : undefined);
      return {
        name: r.name,
        status: 'Archived',
        image,
        description: r.description || product?.desc,
        availableFrom: r.availableFrom,
        availableUntil: r.archivedAt,
        slug: product?.slug,
        notes: r.notes || '',
      };
    });

  const staticArchive = GOYUNIR_STORE_SUITE.catalogPreview.archiveScents.map((item) => ({
    ...item,
    image: item.image,
  }));

  return NextResponse.json({
    activeDrops,
    upcomingDrops: GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
    archiveScents: [...staticArchive, ...dynamicArchive],
    archivedProductIds: Array.from(archivedIds),
    // Per-product live inventory info, so the storefront can show
    // "winners this round / inventory remaining" without a second call.
    liveState: Object.fromEntries(
      Object.entries(liveStateByProductId).map(([productId, live]: any) => [
        productId,
        {
          inventoryRemaining: live.inventoryRemaining,
          totalInventory: live.totalInventory,
          winnersNextDraw: getWinnerCountForDraw(live),
          isActive: live.isActive,
          salesCompleted: live.salesCompleted,
          archiveNotes: archiveNotesById.get(productId) || '',
        },
      ]),
    ),
  });
}