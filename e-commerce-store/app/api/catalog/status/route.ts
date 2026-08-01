import { NextResponse } from 'next/server';
import { createRedisClient, getCatalogArchiveRecords } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({
        archivedProductIds: [],
        notesByProductId: {},
        availableFromByProductId: {},
        records: [],
      });
    }

    const records = await getCatalogArchiveRecords(redis);
    const archivedProductIds = records.map((r) => r.productId);
    const notesByProductId: Record<string, string> = {};
    const availableFromByProductId: Record<string, string> = {};

    for (const r of records) {
      if (r.notes) notesByProductId[r.productId] = r.notes;
      if (r.availableFrom) availableFromByProductId[r.productId] = r.availableFrom;
    }

    // Enrich images from config if missing
    const enriched = records.map((r) => {
      const p = GOYUNIR_STORE_SUITE.productCatalog.find((x) => x.id === r.productId);
      return {
        ...r,
        slug: p?.slug,
        image: r.image || (p ? `/images/${p.prefix}_1.jpg` : undefined),
      };
    });

    return NextResponse.json({
      archivedProductIds,
      notesByProductId,
      availableFromByProductId,
      records: enriched,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, archivedProductIds: [] }, { status: 500 });
  }
}