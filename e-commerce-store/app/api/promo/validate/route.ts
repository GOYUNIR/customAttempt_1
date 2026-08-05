import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, trackPromoClick } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') || '')
    .trim()
    .toUpperCase();
  const email = String(url.searchParams.get('email') || '')
    .trim()
    .toLowerCase();

  if (!code) return NextResponse.json({ valid: false, error: 'No code' });

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ valid: false, error: 'Offline' });

  const raw = await redis.hget(PROMOS_KEY, code);
  const promo = safeParseRedisItem<any>(raw);
  if (!promo || promo.active === false) {
    return NextResponse.json({ valid: false, error: 'Invalid or inactive code' });
  }

  const maxPerEmail =
    typeof promo.maxUsesPerEmail === 'number' ? promo.maxUsesPerEmail : 1;

  // Check if this email has already used this promo
  let alreadyUsed = false;
  if (email && maxPerEmail > 0) {
    const used = await redis.sismember(usedEmailsKey(code), email);
    if (used === 1) {
      alreadyUsed = true;
      return NextResponse.json({
        valid: false,
        error: 'This code has already been used with this email address',
        alreadyUsed: true,
        code,
      });
    }
  }

  // Check if the promoter is trying to use their own code
  if (email && promo.promoterEmail) {
    const promoterEmail = String(promo.promoterEmail).toLowerCase();
    if (promoterEmail === email) {
      return NextResponse.json({
        valid: false,
        error: 'Promoters cannot use their own code',
        alreadyUsed: false,
        code,
      });
    }
  }

  await trackPromoClick(redis, code);

  return NextResponse.json({
    valid: true,
    code,
    customerDiscountPercent: Math.min(50, Math.max(0, Number(promo.customerDiscountPercent) || 0)),
    maxUsesPerEmail: maxPerEmail,
  });
}