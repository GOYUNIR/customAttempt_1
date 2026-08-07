import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';
const CATALOG_CONFIG_KEY = 'store:catalog_config';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const raw = await redis.hgetall(PRODUCTS_KEY);
    const products = Object.values(raw || {}).map((value) => safeParseRedisItem<any>(value)).filter(Boolean) as any[];

    await Promise.all([
      redis.del(ACTIVE_PRODUCTS_KEY),
      redis.del(ARCHIVED_PRODUCTS_KEY),
      redis.del(UPCOMING_PRODUCTS_KEY),
    ]);

    const upcomingDrops: any[] = [];
    const archiveScents: any[] = [];

    for (const product of products) {
      if (product.isActive) {
        await redis.hset(ACTIVE_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      }
      if (product.isArchived) {
        await redis.hset(ARCHIVED_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
        archiveScents.push({
          name: product.name,
          status: 'Archived',
          image: product.images?.[0] || `/images/${product.prefix}/1.jpeg`,
          description: product.desc || '',
          slug: product.slug,
        });
      }
      if (product.isUpcoming && !product.isArchived) {
        await redis.hset(UPCOMING_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
        upcomingDrops.push({
          name: product.name,
          status: 'Upcoming',
          eta: product.tagline || 'Coming soon',
          image: product.images?.[0] || `/images/${product.prefix}/1.jpeg`,
          description: product.desc || '',
          slug: product.slug,
        });
      }
    }

    const dedupe = (items: any[]) => items.filter((item, index, all) => all.findIndex((other) => String(other.slug || other.name) === String(item.slug || item.name)) === index);
    await redis.set(CATALOG_CONFIG_KEY, JSON.stringify({
      upcomingDrops: dedupe(upcomingDrops),
      archiveScents: dedupe(archiveScents),
    }));

    return NextResponse.json({ success: true, products: products.length, upcoming: dedupe(upcomingDrops).length, archived: dedupe(archiveScents).length });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Unable to organize Redis' }, { status: 500 });
  }
}
