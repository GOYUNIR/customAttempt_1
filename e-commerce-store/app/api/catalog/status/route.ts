import { NextResponse } from 'next/server';
import { createRedisClient, getCatalogArchiveRecords } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const redis = createRedisClient();
  const archivedFromRedis = redis ? await getCatalogArchiveRecords(redis) : [];
  const archivedProductIds = new Set(archivedFromRedis.map((r) => r.productId));

  const activeDrops = getVisibleProducts(GOYUNIR_STORE_SUITE)
    .filter((p) => !archivedProductIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, tagline: p.tagline, desc: p.desc }));

  const dynamicArchive = archivedFromRedis.map((r) => ({
    name: r.name,
    status: 'Archived',
    image: r.image,
    description: r.description,
    availableFrom: r.availableFrom,
    availableUntil: r.archivedAt,
  }));

  return NextResponse.json({
    activeDrops,
    upcomingDrops: GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
    archiveScents: [...GOYUNIR_STORE_SUITE.catalogPreview.archiveScents, ...dynamicArchive],
  });
}