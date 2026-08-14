import { NextResponse } from 'next/server';
import { createRedisClient , getAdminPassword, PRODUCTS_KEY} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

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

    const master = getAdminPassword() || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    if (!productId || !file) {
      return NextResponse.json({ error: 'Missing productId or file' }, { status: 400 });
    }

    if (file.size > 6 * 1024 * 1024) {
      return NextResponse.json({ error: 'Image is too large. Keep uploads under 6MB (the admin form compresses images automatically).' }, { status: 413 });
    }

    // Read the file as base64 data URL
    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = (file.type || 'image/jpeg').toLowerCase();
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

    const alreadyPresent = product.images.some((image: unknown) => typeof image === 'string' && image === dataUrl);
    if (!alreadyPresent) {
      product.images.push(dataUrl);
    }
    product.updatedAt = new Date().toISOString();

    // Save back to Redis. Images live inside the product object ONLY — there
    // is no separate `store:product_images:*` key to keep in sync.
    await redis.hset(PRODUCTS_KEY, { [productId]: JSON.stringify(product) });

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