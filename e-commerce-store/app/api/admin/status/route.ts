import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, safeParseRedisItem, POOL_STATS_KEY, LAST_DRAW_KEY, ARCHIVE_LEDGER_KEY, getOnlineVisitors } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    const status = {
      stripeConfigured: Boolean(stripe),
      redisConfigured: Boolean(redis),
      fallbackEntriesCount: 0,
      fallbackEntries: [] as any[],
      pools: [] as any[],
      liveActiveUsersOnline: 1,
      onlineVisitors: [] as { visitorId: string; lastSeenSecondsAgo: number }[],
      lastDraw: null as any,
    };
    if (!redis) return NextResponse.json(status);

    const trafficKey = 'analytics:active_users_online';
    try {
      await redis.zremrangebyscore(trafficKey, 0, Date.now() - 45 * 1000);
      const totalActiveUsersCount = await redis.zcard(trafficKey);
      status.liveActiveUsersOnline = Math.max(1, totalActiveUsersCount);
      status.onlineVisitors = await getOnlineVisitors(redis, trafficKey);
    } catch {}

    try {
      const statsHash = (await redis.hgetall(POOL_STATS_KEY)) as Record<string, string> | null;
      let totalSubs = 0;
      for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
        for (const size of ['50ml', '100ml']) {
          const subCount = Number(statsHash?.[`sub:${product.name}:${size}`] ?? 0);
          const intCount = Number(statsHash?.[`int:${product.name}:${size}`] ?? 0);
          totalSubs += subCount;
          status.pools.push({ product: product.name, size, intCount, subCount, maxLimit: size === '50ml' ? 10 : 5 });
        }
      }
      status.pools.sort((a, b) => `${a.product} ${a.size}`.localeCompare(`${b.product} ${b.size}`));
      status.fallbackEntriesCount = totalSubs;
    } catch {}

    try {
      const lastDrawRaw = await redis.get(LAST_DRAW_KEY);
      status.lastDraw = safeParseRedisItem<any>(lastDrawRaw) ?? null;
    } catch {}

    try {
      const recentRaw = await redis.lrange(ARCHIVE_LEDGER_KEY, -80, -1);
      status.fallbackEntries = recentRaw
        .map((item) => safeParseRedisItem<any>(item))
        .filter(Boolean)
        .reverse();
    } catch {}

    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}