import { NextResponse } from 'next/server';
import { createRedisClient, getCatalogArchiveRecords } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();
    const archived = redis ? await getCatalogArchiveRecords(redis) : [];
    const archivedProductIds = archived.map((r) => r.productId);

    const notesByProductId: Record<string, string> = {};
    const availableFromByProductId: Record<string, string> = {};
    for (const r of archived) {
      if (r.notes) notesByProductId[r.productId] = r.notes;
      if (r.availableFrom) availableFromByProductId[r.productId] = r.availableFrom;
    }

    const activeDrops = getVisibleProducts(GOYUNIR_STORE_SUITE)
      .filter((p) => !archivedProductIds.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name, tagline: p.tagline, desc: p.desc, slug: p.slug }));

    const dynamicArchiveScents = archived.map((r) => {
      const product = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.id === r.productId);
      const isSoldOut = r.soldOut || String(r.availableFrom || '').toLowerCase() === 'sold out';
      return {
        name: r.name,
        status: isSoldOut ? 'Sold Out' : 'Archived',
        image: r.image || (product ? `/images/${product.prefix}_1.jpeg` : undefined),
        description: r.notes || r.description || product?.desc,
        availableFrom: r.availableFrom,
        availableUntil: r.archivedAt,
        slug: product?.slug,
      };
    });

    return NextResponse.json({
      activeDrops,
      upcomingDrops: GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
      archiveScents: [...GOYUNIR_STORE_SUITE.catalogPreview.archiveScents, ...dynamicArchiveScents],
      archivedProductIds,
      notesByProductId,
      availableFromByProductId,
      records: archived,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, activeDrops: [], upcomingDrops: [], archiveScents: [], archivedProductIds: [] }, { status: 500 });
  }
}