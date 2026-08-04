import { NextResponse } from 'next/server';
import { createRedisClient, getCatalogArchiveRecords } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();

    if (!redis) {
      return NextResponse.json({
        activeDrops: [],
        upcomingDrops: GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
        archiveScents: GOYUNIR_STORE_SUITE.catalogPreview.archiveScents,
        archivedProductIds: [] as string[],
        soldOutProductIds: [] as string[],
        notesByProductId: {} as Record<string, string>,
        availableFromByProductId: {} as Record<string, string>,
        records: [] as any[],
      });
    }

    const archived = await getCatalogArchiveRecords(redis);
    const archivedProductIds = archived.map((r) => r.productId);

    const notesByProductId: Record<string, string> = {};
    const availableFromByProductId: Record<string, string> = {};
    const soldOutProductIds: string[] = [];

    for (const r of archived) {
      if (r.notes) notesByProductId[r.productId] = r.notes;
      if (r.availableFrom) availableFromByProductId[r.productId] = r.availableFrom;
      const isSoldOut =
        r.soldOut === true ||
        String(r.availableFrom || '').toLowerCase() === 'sold out' ||
        /sold\s*out/i.test(String(r.notes || ''));
      if (isSoldOut) soldOutProductIds.push(r.productId);
    }

    const activeDrops = getVisibleProducts(GOYUNIR_STORE_SUITE)
      .filter((p) => !archivedProductIds.includes(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        tagline: p.tagline,
        desc: p.desc,
        slug: p.slug,
        image: `/images/${p.prefix}/1.jpeg`,
      }));

    const dynamicArchiveScents = archived.map((r) => {
      const product = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.id === r.productId);
      const isSoldOut =
        r.soldOut === true ||
        String(r.availableFrom || '').toLowerCase() === 'sold out' ||
        /sold\s*out/i.test(String(r.notes || ''));
      return {
        name: r.name || product?.name || r.productId,
        status: isSoldOut ? 'Sold Out' : 'Archived',
        image: r.image || (product ? `/images/${product.prefix}/1.jpeg` : undefined),
        description: r.notes || r.description || product?.desc,
        availableFrom: r.availableFrom,
        availableUntil: r.archivedAt,
        slug: product?.slug,
        productId: r.productId,
        soldOut: isSoldOut,
      };
    });

    const staticArchive = GOYUNIR_STORE_SUITE.catalogPreview.archiveScents.filter(
      (s) => !dynamicArchiveScents.some((d) => d.name === s.name),
    );

    const records = archived.map((r) => {
      const product = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.id === r.productId);
      const isSoldOut =
        r.soldOut === true ||
        String(r.availableFrom || '').toLowerCase() === 'sold out' ||
        /sold\s*out/i.test(String(r.notes || ''));
      return {
        ...r,
        slug: product?.slug,
        name: r.name || product?.name,
        image: r.image || (product ? `/images/${product.prefix}/1.jpeg` : undefined),
        soldOut: isSoldOut,
      };
    });

    return NextResponse.json({
      activeDrops,
      upcomingDrops: GOYUNIR_STORE_SUITE.catalogPreview.upcomingDrops,
      archiveScents: [...dynamicArchiveScents, ...staticArchive],
      archivedProductIds,
      soldOutProductIds,
      notesByProductId,
      availableFromByProductId,
      records,
    });
  } catch (err: any) {
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