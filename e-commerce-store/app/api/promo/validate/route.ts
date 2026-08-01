import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, trackPromoClick } from '@/lib/server-config';

export const dynamic = 'force-dynamic';
const PROMOS_KEY = 'config:promos';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
  if (!code) return NextResponse.json({ valid: false });

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ valid: false });

  const raw = await redis.hget(PROMOS_KEY, code);
  const promo = safeParseRedisItem<any>(raw);
  if (!promo || promo.active === false) return NextResponse.json({ valid: false });

  // First validation per link click also counts as a "click" — logs that
  // the link was actually opened, separate from an eventual entry ("use").
  await trackPromoClick(redis, code);

  return NextResponse.json({
    valid: true,
    code,
    customerDiscountPercent: Math.min(50, Math.max(0, Number(promo.customerDiscountPercent) || 0)),
  });
}