import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, safeParseRedisItem, POOL_STATS_KEY, LAST_DRAW_KEY, ARCHIVE_LEDGER_KEY } from '@/lib/server-config';
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
      lastDraw: null as any,
    };
    if (!redis) return NextResponse.json(status);

    try {
      const trafficKey = 'analytics:active_users_online';
      await redis.zremrangebyscore(trafficKey, 0, Date.now() - 45 * 1000);
      const totalActiveUsersCount = await redis.zcard(trafficKey);
      status.liveActiveUsersOnline = Math.max(1, totalActiveUsersCount);
    } catch {}

    // ONE hash read instead of 8 separate list scans — the biggest single
    // command-count reduction on the whole site.
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

    // Bounded default view: most recent 50 archive records, so the admin
    // sees something on load without scanning the entire permanent history
    // every time this route is polled.
    try {
      const recentRaw = await redis.lrange(ARCHIVE_LEDGER_KEY, -50, -1);
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