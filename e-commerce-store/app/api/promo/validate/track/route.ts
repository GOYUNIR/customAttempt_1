import { NextResponse } from 'next/server';
import { createRedisClient, trackPromoClick } from '@/lib/server-config';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const limited = await rateLimitedResponse('promo_track', request, 30, 60);
    if (limited) return limited;
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ ok: false });
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false });
    }
    const code = String(body?.code || '').trim().toUpperCase().slice(0, 40);
    if (!code) return NextResponse.json({ ok: false });
    const tracked = await trackPromoClick(redis, code);
    return NextResponse.json({ ok: tracked });
  } catch {
    return NextResponse.json({ ok: false });
  }
}