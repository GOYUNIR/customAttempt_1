import { NextResponse } from 'next/server';
import { createRedisClient, getCatalogArchiveRecords, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();
    const sortProducts = (items: any[]) => [...items].sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)));
    if (!redis) {
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
    const catalogConfig = safeParseRedisItem<any>(await redis.get('store:catalog_config')) || {};
    const configuredUpcoming = Array.isArray(catalogConfig.upcomingDrops) ? catalogConfig.upcomingDrops : [];
    const configuredArchive = Array.isArray(catalogConfig.archiveScents) ? catalogConfig.archiveScents : [];

    // Get ALL products from Redis
    const allRaw = await redis.hgetall('store:products');
    const allProducts: any[] = [];
    if (allRaw) {
      for (const [key, value] of Object.entries(allRaw)) {
        try {
          const product = JSON.parse(typeof value === 'string' ? value : '{}');
          allProducts.push(product);
        } catch (e) {
          console.error('[catalog/status] Error parsing product:', e);
        }
      }
    }

    // Separate into categories - sort by sortOrder
    const sortedProducts = sortProducts(allProducts);

    const activeDrops = sortedProducts
      .filter(p => p.isActive && !p.isArchived && !p.isUpcoming && !archivedProductIds.includes(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        tagline: p.tagline || 'LIMITED DROP',
        desc: p.desc || '',
        slug: p.slug,
        image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
      }));

    const upcomingFromProducts = sortedProducts
      .filter(p => p.isUpcoming && !p.isArchived)
      .map(p => ({
        name: p.name,
        status: 'Upcoming',
        eta: p.tagline || 'Coming soon',
        image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
        description: p.desc || '',
        slug: p.slug,
      }));

    const upcomingDrops = sortProducts(
      [...upcomingFromProducts, ...configuredUpcoming].filter((item: any, index: number, all: any[]) => all.findIndex((v: any) => String(v.slug || v.name) === String(item.slug || item.name)) === index),
    );

    const archiveFromProducts = sortedProducts
      .filter(p => p.isArchived || archivedProductIds.includes(p.id))
      .map(p => ({
        name: p.name,
        status: 'Archived',
        image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
        description: p.desc || p.notes?.[0]?.text || '',
        availableFrom: p.availableFrom || 'Previously available',
        slug: p.slug,
        productId: p.id,
        soldOut: p.totalInventory === 0,
      }));

    const archiveScents = sortProducts(
      [...archiveFromProducts, ...configuredArchive].filter((item: any, index: number, all: any[]) => all.findIndex((v: any) => String(v.slug || v.name) === String(item.slug || item.name)) === index),
    );

    return NextResponse.json({
      activeDrops,
      upcomingDrops,
      archiveScents,
      archivedProductIds,
      soldOutProductIds: [],
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