import { NextResponse } from 'next/server';
import {
  createRedisClient,
  getCatalogArchiveRecords,
  archiveProductToCatalog,
  unarchiveProductFromCatalog,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { resolveProductSchedule, scheduledDateToTimestamp } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({
      activeDrops: GOYUNIR_STORE_SUITE.productCatalog.filter((p) => p.isActive !== false),
      upcomingDrops: GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
      archiveScents: GOYUNIR_STORE_SUITE.catalogPreview.archiveScents,
      archivedProductIds: [],
    });
  }

  const now = Date.now();
  const archivedRecords = await getCatalogArchiveRecords(redis);
  const archivedIds = new Set(archivedRecords.map((r) => r.productId));

  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
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

  const activeDrops = GOYUNIR_STORE_SUITE.productCatalog.filter(
    (p) => p.isActive !== false && !archivedIds.has(p.id),
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
  });
}