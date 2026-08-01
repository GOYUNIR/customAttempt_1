import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  POOL_STATS_KEY,
  LAST_DRAW_KEY,
  ARCHIVE_LEDGER_KEY,
  getOnlineVisitors,
  getLiveProductState,
  getWinnerCountForDraw,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getAvailableSizes } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    const status = {
      stripeConfigured: Boolean(stripe), redisConfigured: Boolean(redis),
      fallbackEntries: [] as any[], pools: [] as any[],
      liveActiveUsersOnline: 1, onlineVisitors: [] as any[], lastDraw: null as any,
    };
    if (!redis) return NextResponse.json(status);

    const trafficKey = 'analytics:active_users_online';
    try {
      await redis.zremrangebyscore(trafficKey, 0, Date.now() - 45 * 1000);
      status.liveActiveUsersOnline = Math.max(1, await redis.zcard(trafficKey));
      status.onlineVisitors = await getOnlineVisitors(redis, trafficKey, 50);
    } catch {}

    try {
      const statsHash = (await redis.hgetall(POOL_STATS_KEY)) as Record<string, string> | null;
      const size = getAvailableSizes(GOYUNIR_STORE_SUITE)[0] || '50ml';
      for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
        for (const sz of ['50ml', '100ml']) {
          const live = await getLiveProductState(redis, product.id, sz, {
            isActive: product.isActive !== false,
            totalInventory: product.totalInventory ?? product.maxRaffleAllocationLimit ?? 10,
            winnersPerDraw: product.winnerTiers?.length ? product.winnerTiers : [product.maxRaffleAllocationLimit ?? 1],
          });
          status.pools.push({
            product: product.name, size: sz,
            intCount: Number(statsHash?.[`int:${product.name}:${sz}`] ?? 0),
            subCount: Number(statsHash?.[`sub:${product.name}:${sz}`] ?? 0),
            maxLimit: getWinnerCountForDraw(live),
            inventoryRemaining: live.inventoryRemaining,
            totalInventory: live.totalInventory,
            salesCompleted: live.salesCompleted,
            isActive: live.isActive,
          });
        }
      }
      status.pools.sort((a, b) => `${a.product} ${a.size}`.localeCompare(`${b.product} ${b.size}`));
    } catch {}

    try {
      const lastDrawRaw = await redis.get(LAST_DRAW_KEY);
      status.lastDraw = safeParseRedisItem<any>(lastDrawRaw) ?? null;
    } catch {}

    try {
      const recentRaw = await redis.lrange(ARCHIVE_LEDGER_KEY, -80, -1);
      status.fallbackEntries = recentRaw.map((item) => safeParseRedisItem<any>(item)).filter(Boolean).reverse();
    } catch {}

    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}