import { NextResponse } from 'next/server';
import { createRedisClient, archiveProductToCatalog } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Database offline.' }, { status: 500 });

    const body = await request.json();
    const { productId, name, image, description, availableFrom, verificationKey } = body;

    const masterPassword = process.env.ADMIN_BASIC_AUTH_PASSWORD;
    if (!masterPassword || verificationKey !== masterPassword) {
      return NextResponse.json({ error: '⚠️ ACCESS REJECTED: Invalid master operation password.' }, { status: 403 });
    }
    if (!productId || !name) {
      return NextResponse.json({ error: 'Missing product identification.' }, { status: 400 });
    }

    await archiveProductToCatalog(redis, {
      productId: String(productId),
      name: String(name),
      image: image ? String(image) : undefined,
      description: description ? String(description) : undefined,
      availableFrom: String(availableFrom || 'Unknown'),
      archivedAt: new Date().toISOString(),
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}