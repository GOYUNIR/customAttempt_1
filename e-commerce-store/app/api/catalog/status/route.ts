import { NextResponse } from 'next/server';
import { createRedisClient, getCatalogArchiveRecords } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();

    if (!redis) {
      // Return empty arrays if Redis is unavailable
      return NextResponse.json({
        activeDrops: [],
        upcomingDrops: [],
        archiveScents: [],
        archivedProductIds: [],
        soldOutProductIds: [],
        notesByProductId: {},
        availableFromByProductId: {},
        records: [],
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

    // Get active products from Redis directly
    let activeDrops: any[] = [];
    try {
      const activeRaw = await redis.hgetall('store:active_products');
      if (activeRaw) {
        for (const [key, value] of Object.entries(activeRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            if (product.isActive && !product.isArchived && !archivedProductIds.includes(product.id)) {
              activeDrops.push({
                id: product.id,
                name: product.name,
                tagline: product.tagline || 'LIMITED DROP',
                desc: product.desc || '',
                slug: product.slug,
                image: product.images?.[0] || `/images/${product.prefix}/1.jpeg`,
              });
            }
          } catch (e) {
            console.error('[catalog/status] Error parsing product:', e);
          }
        }
      }
    } catch (e) {
      console.error('[catalog/status] Error fetching active products:', e);
    }

    // Get archived products from Redis
    let archiveScents: any[] = [];
    try {
      const archivedRaw = await redis.hgetall('store:archived_products');
      if (archivedRaw) {
        for (const [key, value] of Object.entries(archivedRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            if (product.isArchived) {
              const isSoldOut =
                product.totalInventory === 0 ||
                String(product.availableFrom || '').toLowerCase() === 'sold out';
              archiveScents.push({
                name: product.name,
                status: isSoldOut ? 'Sold Out' : 'Archived',
                image: product.images?.[0] || `/images/${product.prefix}/1.jpeg`,
                description: product.desc || product.notes?.[0]?.text || '',
                availableFrom: product.availableFrom || 'Previously available',
                slug: product.slug,
                productId: product.id,
                soldOut: isSoldOut,
              });
            }
          } catch (e) {
            console.error('[catalog/status] Error parsing archived product:', e);
          }
        }
      }
    } catch (e) {
      console.error('[catalog/status] Error fetching archived products:', e);
    }

    // Upcoming drops - empty by default, can be managed via admin
    const upcomingDrops: any[] = [];

    return NextResponse.json({
      activeDrops,
      upcomingDrops,
      archiveScents,
      archivedProductIds,
      soldOutProductIds,
      notesByProductId,
      availableFromByProductId,
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