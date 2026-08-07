import { NextResponse } from 'next/server';
import { createRedisClient, getCatalogArchiveRecords, getFallbackStoreProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();

    const fallbackProducts = Object.values(getFallbackStoreProducts()) as any[];
    const sortProducts = (items: any[]) => [...items].sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)));
    if (!redis) {
      return NextResponse.json({
        activeDrops: sortProducts(fallbackProducts)
          .filter((p) => p.isActive !== false && !p.isArchived && !p.isUpcoming)
          .map((p) => ({
            id: p.id,
            name: p.name,
            tagline: p.tagline || 'LIMITED DROP',
            desc: p.desc || '',
            slug: p.slug,
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
          })),
        upcomingDrops: sortProducts(fallbackProducts)
          .filter((p) => p.isUpcoming && !p.isArchived)
          .map((p) => ({
            name: p.name,
            status: 'Upcoming',
            eta: p.tagline || 'Coming soon',
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
            description: p.desc || '',
            slug: p.slug,
          })),
        archiveScents: sortProducts(fallbackProducts)
          .filter((p) => p.isArchived)
          .map((p) => ({
            name: p.name,
            status: 'Archived',
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
            description: p.desc || p.notes?.[0]?.text || '',
            availableFrom: p.availableFrom || 'Previously available',
            slug: p.slug,
            productId: p.id,
            soldOut: p.totalInventory === 0,
          })),
        archivedProductIds: [],
        soldOutProductIds: [],
        notesByProductId: {},
        availableFromByProductId: {},
        records: [],
      });
    }

    const archived = await getCatalogArchiveRecords(redis);
    const archivedProductIds = archived.map((r) => r.productId);

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

    const activeDrops = sortedProducts.length > 0
      ? sortedProducts
          .filter(p => p.isActive && !p.isArchived && !p.isUpcoming && !archivedProductIds.includes(p.id))
          .map(p => ({
            id: p.id,
            name: p.name,
            tagline: p.tagline || 'LIMITED DROP',
            desc: p.desc || '',
            slug: p.slug,
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
          }))
      : sortProducts(fallbackProducts)
          .filter((p) => p.isActive !== false && !p.isArchived && !p.isUpcoming)
          .map((p) => ({
            id: p.id,
            name: p.name,
            tagline: p.tagline || 'LIMITED DROP',
            desc: p.desc || '',
            slug: p.slug,
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
          }));

    const upcomingDrops = sortedProducts.length > 0
      ? sortedProducts
          .filter(p => p.isUpcoming && !p.isArchived)
          .map(p => ({
            name: p.name,
            status: 'Upcoming',
            eta: p.tagline || 'Coming soon',
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
            description: p.desc || '',
            slug: p.slug,
          }))
      : sortProducts(fallbackProducts)
          .filter((p) => p.isUpcoming && !p.isArchived)
          .map((p) => ({
            name: p.name,
            status: 'Upcoming',
            eta: p.tagline || 'Coming soon',
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
            description: p.desc || '',
            slug: p.slug,
          }));

    const archiveScents = sortedProducts.length > 0
      ? sortedProducts
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
          }))
      : sortProducts(fallbackProducts)
          .filter((p) => p.isArchived)
          .map((p) => ({
            name: p.name,
            status: 'Archived',
            image: p.images?.[0] || `/images/${p.prefix}/1.jpeg`,
            description: p.desc || p.notes?.[0]?.text || '',
            availableFrom: p.availableFrom || 'Previously available',
            slug: p.slug,
            productId: p.id,
            soldOut: p.totalInventory === 0,
          }));

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