import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem , getAdminPassword, PRODUCTS_KEY} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

// Images live INSIDE the product object in store:products (single source of
// truth). No separate `store:product_images:*` keys exist anymore.

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get('productId');

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ images: [] });

    if (productId) {
      const raw = await redis.hget(PRODUCTS_KEY, productId);
      const product = safeParseRedisItem<any>(raw);
      const images = Array.isArray(product?.images) ? product.images : [];
      return NextResponse.json({ images });
    }

    // No productId → aggregate all product images keyed by product id.
    const raw = await redis.hgetall(PRODUCTS_KEY);
    const imagesByProduct: Record<string, string[]> = {};
    if (raw) {
      for (const [key, value] of Object.entries(raw)) {
        const product = safeParseRedisItem<any>(value);
        if (product && Array.isArray(product.images)) {
          imagesByProduct[key] = product.images;
        }
      }
    }
    return NextResponse.json({ images: imagesByProduct });
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
    const master = getAdminPassword() || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const productId = String(body?.productId || '');
    const images = Array.isArray(body?.images) ? body.images : [];
    const action = String(body?.action || 'set');

    if (!productId) {
      return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
    }

    // All image state is read/written through the product object in
    // store:products — no separate image keys to keep in sync.
    const raw = await redis.hget(PRODUCTS_KEY, productId);
    const product = safeParseRedisItem<any>(raw);
    const current = (Array.isArray(product?.images) ? product.images : []).filter(Boolean);

    if (action === 'add') {
      const newImages = [...current, ...images];
      await updateProductImages(redis, productId, newImages);
      return NextResponse.json({ success: true, images: newImages });
    }

    if (action === 'remove') {
      const index = Number(body?.index ?? -1);
      if (index < 0) return NextResponse.json({ error: 'Invalid index' }, { status: 400 });
      if (index >= current.length) return NextResponse.json({ error: 'Index out of range' }, { status: 400 });
      const next = [...current];
      next.splice(index, 1);
      await updateProductImages(redis, productId, next);
      return NextResponse.json({ success: true, images: next });
    }

    if (action === 'reorder') {
      const order = Array.isArray(body?.order) ? body.order : [];
      if (!order.length) return NextResponse.json({ error: 'Invalid order' }, { status: 400 });
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
      await updateProductImages(redis, productId, reordered);
      return NextResponse.json({ success: true, images: reordered });
    }

    // set - replace all
    await updateProductImages(redis, productId, images);
    return NextResponse.json({ success: true, images });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

async function updateProductImages(redis: any, productId: string, images: string[]) {
  const raw = await redis.hget(PRODUCTS_KEY, productId);
  const product = safeParseRedisItem<any>(raw);
  if (product) {
    product.images = Array.isArray(images) ? images : [];
    product.updatedAt = new Date().toISOString();
    await redis.hset(PRODUCTS_KEY, { [productId]: JSON.stringify(product) });
  }
}

export async function DELETE(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';
    const master = getAdminPassword() || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const productId = url.searchParams.get('productId');
    if (!productId) {
      return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
    }

    // Clear the product's images array — no separate image key to delete.
    await updateProductImages(redis, productId, []);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}