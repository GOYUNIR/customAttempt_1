import { NextResponse } from 'next/server';
import { createRedisClient, PRODUCTS_KEY } from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';

export const dynamic = 'force-dynamic';

// The products panel accepts images AND videos. Photos are compressed client-
// side (jpg/png/webp/bmp/avif → JPEG); vector/animated (svg/gif) and ALL videos
// are stored with their original bytes, so the server keeps per-type caps.
const ACCEPTED_IMAGE_EXTS = new Set(['png', 'jpeg', 'jpg', 'svg', 'webp', 'gif', 'bmp', 'avif']);
const ACCEPTED_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm']);
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB — photos are auto-compressed
const MAX_VIDEO_BYTES = 18 * 1024 * 1024; // 18MB — videos are stored as-is

function mediaKind(file: File): 'image' | 'video' | null {
  const name = String(file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() || '' : '';
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('image/') || ACCEPTED_IMAGE_EXTS.has(ext)) {
    return ACCEPTED_IMAGE_EXTS.has(ext) ? 'image' : type.startsWith('image/') ? 'image' : null;
  }
  if (type.startsWith('video/') || ACCEPTED_VIDEO_EXTS.has(ext)) {
    return ACCEPTED_VIDEO_EXTS.has(ext) ? 'video' : type.startsWith('video/') ? 'video' : null;
  }
  return null;
}

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

    if (!(await adminAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    if (!productId || !file) {
      return NextResponse.json({ error: 'Missing productId or file' }, { status: 400 });
    }

    const kind = mediaKind(file);
    if (!kind) {
      return NextResponse.json({
        error: 'Unsupported file type. Use PNG, JPEG, JPG, SVG, WEBP, GIF, BMP or video (MP4, MOV, MKV, AVI, WEBM).',
      }, { status: 415 });
    }

    const cap = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (file.size > cap) {
      const mb = Math.round(cap / 1024 / 1024);
      return NextResponse.json({
        error: kind === 'video' ? `Video is too large. Keep uploads under ${mb}MB.` : `Image is too large. Keep uploads under ${mb}MB (the admin form compresses photos automatically).`,
      }, { status: 413 });
    }

    // Read the file as base64 data URL — the same storage format the product
    // page gallery renders (data: URLs for both images and videos).
    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = (file.type || (kind === 'video' ? 'video/mp4' : 'image/jpeg')).toLowerCase();
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
      // Keep the parallel crop list aligned with the media list.
      if (Array.isArray(product.crops)) {
        product.crops.push({ x: 0.5, y: 0.5, w: 1, h: 1 });
      }
    }
    product.updatedAt = new Date().toISOString();

    // Save back to Redis. Images live inside the product object ONLY — there
    // is no separate `store:product_images:*` key to keep in sync.
    await redis.hset(PRODUCTS_KEY, { [productId]: JSON.stringify(product) });

    return NextResponse.json({
      success: true,
      message: 'File uploaded successfully',
      imageCount: product.images.length,
    });
  } catch (err: any) {
    console.error('[upload/route] Error:', err);
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 });
  }
}