import { NextResponse } from 'next/server';
import { createRedisClient, loadProducts, safeParseRedisItem, trackPromoClick } from '@/lib/server-config';

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
  const productId = String(url.searchParams.get('productId') || '').trim();
  const size = String(url.searchParams.get('size') || '').trim();
  const orderSubtotalCents = Math.max(0, Math.round(Number(url.searchParams.get('orderSubtotal') || 0) * 100));

  if (!code) return NextResponse.json({ valid: false, error: 'No code' });

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ valid: false, error: 'Offline' });

  const raw = await redis.hget(PROMOS_KEY, code);
  const promo = safeParseRedisItem<any>(raw);
  if (!promo || promo.active === false) {
    return NextResponse.json({ valid: false, error: 'Invalid or inactive code' });
  }

  // Giftable codes (store credit redeemed with the admin "gift/share"
  // toggle on) are transferable — the issuedForEmail reservation is skipped.
  if (promo.giftable !== true && promo.issuedForEmail && email && String(promo.issuedForEmail).toLowerCase() !== email) {
    return NextResponse.json({ valid: false, error: 'This code is reserved for a different account' });
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

  if (productId) {
    const products = await loadProducts(redis);
    const product = products[productId];
    const eligibleProductSlugs = Array.isArray(promo.eligibleProductSlugs) ? promo.eligibleProductSlugs.map(String) : [];
    const eligibleSizes = Array.isArray(promo.eligibleSizes) ? promo.eligibleSizes.map(String) : [];
    if (eligibleProductSlugs.length > 0 && (!product || !eligibleProductSlugs.includes(String(product.slug || '')))) {
      return NextResponse.json({ valid: false, error: 'This code only works on selected full-size items' });
    }
    if (eligibleSizes.length > 0 && size && !eligibleSizes.includes(size)) {
      return NextResponse.json({ valid: false, error: 'This code only works on selected sizes' });
    }
  }

  const minimumOrderSubtotalCents = Math.max(0, Number(promo.minimumOrderSubtotalCents || 0));
  if (minimumOrderSubtotalCents > 0 && orderSubtotalCents > 0 && orderSubtotalCents < minimumOrderSubtotalCents) {
    return NextResponse.json({ valid: false, error: `This code unlocks on orders over $${(minimumOrderSubtotalCents / 100).toFixed(2)}` });
  }

  await trackPromoClick(redis, code);

  return NextResponse.json({
    valid: true,
    code,
    customerDiscountPercent: Math.min(50, Math.max(0, Number(promo.customerDiscountPercent) || 0)),
    fixedDiscountCents: Math.max(0, Number(promo.fixedDiscountCents || 0)),
    minimumOrderSubtotalCents,
    eligibleProductSlugs: Array.isArray(promo.eligibleProductSlugs) ? promo.eligibleProductSlugs : [],
    eligibleSizes: Array.isArray(promo.eligibleSizes) ? promo.eligibleSizes : [],
    maxUsesPerEmail: maxPerEmail,
  });
}