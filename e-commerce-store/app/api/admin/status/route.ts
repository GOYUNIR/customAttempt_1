import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  getOrSeedLiveState,
  getOnlineVisitors,
  POOL_STATS_KEY,
  LAST_DRAW_KEY,
  ARCHIVE_LEDGER_KEY,
  loadProducts,
  ANALYTICS_ONLINE_KEY,
  getAdminPassword,
  adminRequestAuthorized,
} from '@/lib/server-config';

function parseWinnerTier(value: unknown): number {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'number' || (typeof item === 'string' && item.trim()));
    if (typeof first === 'number' && Number.isFinite(first)) return first;
    if (typeof first === 'string' && first.trim()) {
      const parsed = Number(first.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  }

  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => Number(part.trim())).filter((part) => Number.isFinite(part));
    return parts[0] ?? 0;
  }

  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!adminRequestAuthorized(request, password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const hasStripeKey = Boolean(process.env.STRIPE_SECRET_KEY);
    const hasRedisUrl = Boolean(
      process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_REST_URL || process.env.REDIS_URL,
    );
    const hasRedisToken = Boolean(
      process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_TOKEN || process.env.REDIS_TOKEN,
    );
    const hasResend = Boolean(process.env.RESEND_API_KEY);

    let redis = null as ReturnType<typeof createRedisClient>;
    let stripe = null as ReturnType<typeof createStripeClient>;
    let redisError: string | null = null;
    let stripeError: string | null = null;

    try { redis = createRedisClient(); } catch (e: any) { redisError = e?.message; }
    try { stripe = createStripeClient(); } catch (e: any) { stripeError = e?.message; }

    let redisOk = false;
    let stripeOk = false;
    if (redis) {
      try { await redis.ping(); redisOk = true; } catch (e: any) { redisError = e?.message; redis = null; }
    }
    if (stripe) {
      try { await stripe.balance.retrieve(); stripeOk = true; } catch (e: any) { stripeError = e?.message; stripeOk = hasStripeKey; }
    }

    const status: any = {
      stripeConfigured: Boolean(stripe) || hasStripeKey,
      redisConfigured: redisOk || (hasRedisUrl && hasRedisToken),
      resendConfigured: hasResend,
      resendFrom: process.env.RESEND_FROM || null,
      stripeOk,
      redisOk,
      redisError,
      stripeError,
      env: {
        hasStripeKey,
        hasRedisUrl,
        hasRedisToken,
        hasResend,
        hasAdminEmail: Boolean(process.env.ADMIN_VERIFY_EMAIL || process.env.SUPPORT_EMAIL || process.env.REPLY_TO_EMAIL),
        hasAdminPassword: Boolean(getAdminPassword()),
        hasCronSecret: Boolean(process.env.CRON_SECRET),
      },
      fallbackEntries: [] as any[],
      pools: [] as any[],
      liveActiveUsersOnline: 0,
      onlineVisitors: [] as any[],
      lastDraw: null as any,
    };

    if (!redis) return NextResponse.json(status);

    const trafficKey = ANALYTICS_ONLINE_KEY;
    try {
      await redis.zremrangebyscore(trafficKey, 0, Date.now() - 45 * 1000);
      status.liveActiveUsersOnline = await redis.zcard(trafficKey);
      status.onlineVisitors = await getOnlineVisitors(redis, trafficKey, 50);
    } catch {}

    try {
      const statsHash = (await redis.hgetall(POOL_STATS_KEY)) as Record<string, string> | null;
      const allProducts = await loadProducts(redis);
      const productsList = Object.values(allProducts);

      for (const product of productsList) {
        const cats = product.priceCategories || [];
        for (const cat of cats) {
          const size = cat.size;
          const winnersPerDraw = parseWinnerTier(cat.winnerTiers);
          const live = await getOrSeedLiveState(redis, product, size, winnersPerDraw);
          const intCount = Number(statsHash?.[`int:${product.name}:${size}`] ?? 0);
          const subCount = Number(statsHash?.[`sub:${product.name}:${size}`] ?? 0);
          status.pools.push({
            product: product.name,
            productId: product.id,
            size,
            intCount,
            subCount,
            salesCount: live.salesCompleted || 0,
            maxLimit: live.inventoryRemaining || 0,
            totalInventory: live.totalInventory || 0,
            winnersPerDraw: live.winnersPerDraw || 0,
            drawsCompleted: live.drawsCompleted || 0,
          });
        }
      }
      status.pools.sort((a: any, b: any) => `${a.product} ${a.size}`.localeCompare(`${b.product} ${b.size}`));
    } catch (e: any) {
      status.poolsError = e?.message;
    }

    try {
      const lastDrawRaw = await redis.get(LAST_DRAW_KEY);
      status.lastDraw = safeParseRedisItem<any>(lastDrawRaw) ?? null;
    } catch {}

    try {
      const recentRaw = await redis.lrange(ARCHIVE_LEDGER_KEY, -150, -1);
      status.fallbackEntries = recentRaw.map((item: string) => safeParseRedisItem<any>(item)).filter(Boolean).reverse();
    } catch {}

    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json(
      {
        error: err?.message || 'status failed',
        stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
        redisConfigured: Boolean(
          (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_REST_URL || process.env.REDIS_URL) &&
            (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_TOKEN || process.env.REDIS_TOKEN),
        ),
        resendConfigured: Boolean(process.env.RESEND_API_KEY),
        pools: [],
        fallbackEntries: [],
      },
      { status: 500 },
    );
  }
}