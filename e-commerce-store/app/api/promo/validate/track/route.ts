import { NextResponse } from 'next/server';
import { createRedisClient, trackPromoClick } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ ok: false });
    const body = await request.json();
    const code = String(body?.code || '').trim().toUpperCase();
    if (!code) return NextResponse.json({ ok: false });
    const tracked = await trackPromoClick(redis, code);
    return NextResponse.json({ ok: tracked });
  } catch {
    return NextResponse.json({ ok: false });
  }
}