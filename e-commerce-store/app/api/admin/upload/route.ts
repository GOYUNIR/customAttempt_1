import { NextResponse } from 'next/server';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({ error: 'Redis offline' }, { status: 500 });
    }

    const formData = await request.formData();
    const productId = formData.get('productId') as string;
    const file = formData.get('file') as File;
    const password = formData.get('password') as string;

    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    if (!productId || !file) {
      return NextResponse.json({ error: 'Missing productId or file' }, { status: 400 });
    }

    // Read the file as base64 data URL
    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = file.type || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Get the current product from Redis
    const raw = await redis.hget(PRODUCTS_KEY, productId);
    // raw can be string | null, but hget may return {} if not found, so we check
    let product = null;
    if (typeof raw === 'string') {
      try {
        product = JSON.parse(raw);
      } catch {
        // If parse fails, treat as null
        product = null;
      }
    }

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // Ensure images array exists
    if (!Array.isArray(product.images)) {
      product.images = [];
    }

    // Append the new image
    product.images.push(dataUrl);
    product.updatedAt = new Date().toISOString();

    // Save back to Redis
    await redis.hset(PRODUCTS_KEY, { [productId]: JSON.stringify(product) });

    // Also update the active/archived/upcoming indexes if needed
    if (product.isActive && !product.isArchived && !product.isUpcoming) {
      await redis.hset('store:active_products', { [productId]: JSON.stringify(product) });
    } else if (product.isArchived) {
      await redis.hset('store:archived_products', { [productId]: JSON.stringify(product) });
    } else if (product.isUpcoming) {
      await redis.hset('store:upcoming_products', { [productId]: JSON.stringify(product) });
    }

    return NextResponse.json({
      success: true,
      message: 'Image uploaded successfully',
      imageCount: product.images.length,
    });
  } catch (err: any) {
    console.error('[upload/route] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}