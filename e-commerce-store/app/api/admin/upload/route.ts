import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { createRedisClient } from '@/lib/server-config';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const formData = await request.formData();
    const password = formData.get('password') as string;
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const productId = formData.get('productId') as string;
    if (!productId) return NextResponse.json({ error: 'Missing productId' }, { status: 400 });

    const files = formData.getAll('files') as File[];
    if (!files.length) return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });

    const uploadDir = path.join(process.cwd(), 'public', 'uploads', productId);
    await mkdir(uploadDir, { recursive: true });

    // Get existing images from product to determine next number
    const PRODUCTS_KEY = 'store:products';
    const raw = await redis.hget(PRODUCTS_KEY, productId);
    const product = raw ? JSON.parse(raw) : null;
    const existingImages = product?.images || [];
    const existingCount = existingImages.length;

    const uploadedUrls: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = path.extname(file.name) || '.jpg';
      const newName = `${existingCount + i + 1}${ext}`;
      const filePath = path.join(uploadDir, newName);
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(filePath, buffer);
      const url = `/uploads/${productId}/${newName}`;
      uploadedUrls.push(url);
    }

    // Update product's images array
    const newImages = [...existingImages, ...uploadedUrls];
    if (product) {
      product.images = newImages;
      product.updatedAt = new Date().toISOString();
      await redis.hset(PRODUCTS_KEY, { [productId]: JSON.stringify(product) });
      // Also update indexes (active, archived, upcoming) if needed
    }

    return NextResponse.json({ success: true, images: newImages, uploaded: uploadedUrls });
  } catch (err: any) {
    console.error('[upload] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}