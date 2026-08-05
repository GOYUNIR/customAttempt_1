import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const IMAGES_KEY = 'store:product_images';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get('productId');
    
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ images: [] });
    
    const key = productId ? `${IMAGES_KEY}:${productId}` : IMAGES_KEY;
    const raw = await redis.get(key);
    const images = safeParseRedisItem<string[]>(raw) || [];
    return NextResponse.json({ images });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, images: [] }, { status: 500 });
  }
}

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

    const productId = String(body?.productId || '');
    const images = Array.isArray(body?.images) ? body.images : [];
    const action = String(body?.action || 'set');

    if (!productId) {
      return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
    }

    const key = `${IMAGES_KEY}:${productId}`;

    if (action === 'add') {
      const current = safeParseRedisItem<string[]>(await redis.get(key)) || [];
      const newImages = [...current, ...images];
      await redis.set(key, JSON.stringify(newImages));
      // Also update the product's images field
      await updateProductImages(redis, productId, newImages);
      return NextResponse.json({ success: true, images: newImages });
    }

    if (action === 'remove') {
      const index = Number(body?.index ?? -1);
      if (index < 0) return NextResponse.json({ error: 'Invalid index' }, { status: 400 });
      const current = safeParseRedisItem<string[]>(await redis.get(key)) || [];
      if (index >= current.length) return NextResponse.json({ error: 'Index out of range' }, { status: 400 });
      current.splice(index, 1);
      await redis.set(key, JSON.stringify(current));
      await updateProductImages(redis, productId, current);
      return NextResponse.json({ success: true, images: current });
    }

    if (action === 'reorder') {
      const order = Array.isArray(body?.order) ? body.order : [];
      if (!order.length) return NextResponse.json({ error: 'Invalid order' }, { status: 400 });
      const current = safeParseRedisItem<string[]>(await redis.get(key)) || [];
      const reordered: string[] = [];
      for (const idx of order) {
        const numIdx = Number(idx);
        if (numIdx >= 0 && numIdx < current.length) {
          reordered.push(current[numIdx]);
        }
      }
      if (reordered.length !== current.length) {
        return NextResponse.json({ error: 'Invalid order array - must contain all indices' }, { status: 400 });
      }
      await redis.set(key, JSON.stringify(reordered));
      await updateProductImages(redis, productId, reordered);
      return NextResponse.json({ success: true, images: reordered });
    }

    // set - replace all
    await redis.set(key, JSON.stringify(images));
    await updateProductImages(redis, productId, images);
    return NextResponse.json({ success: true, images });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function updateProductImages(redis: any, productId: string, images: string[]) {
  const PRODUCTS_KEY = 'store:products';
  const raw = await redis.hget(PRODUCTS_KEY, productId);
  const product = safeParseRedisItem<any>(raw);
  if (product) {
    product.images = images;
    product.updatedAt = new Date().toISOString();
    await redis.hset(PRODUCTS_KEY, { [productId]: JSON.stringify(product) });
    // Also update active/archived indexes
    if (product.isActive && !product.isArchived) {
      await redis.hset('store:active_products', { [productId]: JSON.stringify(product) });
    } else if (product.isArchived) {
      await redis.hset('store:archived_products', { [productId]: JSON.stringify(product) });
    }
  }
}

export async function DELETE(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const productId = url.searchParams.get('productId');
    if (!productId) {
      return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
    }

    const key = `${IMAGES_KEY}:${productId}`;
    await redis.del(key);
    await updateProductImages(redis, productId, []);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}