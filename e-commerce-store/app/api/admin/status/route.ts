import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();

    const status = {
      stripeConfigured: Boolean(stripe),
      redisConfigured: Boolean(redis),
      fallbackEntriesCount: 0,
      fallbackEntries: [] as any[],
      pools: [] as any[],
      liveActiveUsersOnline: 1
    };

    if (!redis) return NextResponse.json(status);

    try {
      const url = new URL(request.url);
      const trafficKey = 'analytics:active_users_online';
      const currentTimeClock = Date.now();

      if (url.searchParams.get('heartbeat') === 'true') {
        const dummyVisitorId = url.searchParams.get('visitorId') || `v_${Math.random().toString(36).substring(7)}`;
        await redis.zadd(trafficKey, { score: currentTimeClock, member: dummyVisitorId });
      }

      await redis.zremrangebyscore(trafficKey, 0, currentTimeClock - 30 * 1000);
      const totalActiveUsersCount = await redis.zcard(trafficKey);
      status.liveActiveUsersOnline = Math.max(1, totalActiveUsersCount);
    } catch {}

    let totalCombinedCount = 0;
    const combinedCustomerLedger: any[] = [];
    const poolPromises: Promise<void>[] = [];

    for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
      for (const size of ['50ml', '100ml']) {
        const poolKey = `drop_pool:${product.name}:${size}`;
        const intentKey = `intent_pool:${product.name}:${size}`;

        const promise = Promise.all([
          redis.lrange(poolKey, 0, -1),
          redis.lrange(intentKey, 0, -1)
        ]).then(async ([rawSubs, rawIntents]) => {
          const sCount = rawSubs?.length || 0;
          const iCount = rawIntents?.length || 0;
          totalCombinedCount += sCount;

          status.pools.push({
            product: product.name,
            size,
            intCount: iCount,
            subCount: sCount,
            maxLimit: size === '50ml' ? 10 : 5
          });

          const parseListItems = (items: string[], labelType: 'SUBMISSION' | 'INTENT') => {
            for (const itemStr of items) {
              try {
                let parsed = JSON.parse(itemStr);
                if (parsed && typeof parsed === 'object' && parsed.email && typeof parsed.email === 'object') {
                  parsed = parsed.email;
                }

                combinedCustomerLedger.push({
                  email: String(parsed?.email || 'goyunir@gmail.com'),
                  variant: product.name,
                  size,
                  shippingAddress: String(parsed?.shippingAddress || parsed?.address || 'Form Input Captured'),
                  id: String(parsed?.id || parsed?.stripeCustomerId || 'Legacy Ref Trace'),
                  registeredAt: parsed?.registeredAt || new Date().toISOString(),
                  type: labelType
                });
              } catch {
                combinedCustomerLedger.push({
                  email: String(itemStr || 'goyunir@gmail.com'),
                  variant: product.name,
                  size,
                  shippingAddress: 'Form Input Captured',
                  id: 'Legacy Ref Trace',
                  registeredAt: new Date().toISOString(),
                  type: labelType
                });
              }
            }
          };

          if (sCount > 0) parseListItems(rawSubs, 'SUBMISSION');
          if (iCount > 0) parseListItems(rawIntents, 'INTENT');
        }).catch(() => {});

        poolPromises.push(promise);
      }
    }

    await Promise.all(poolPromises);

    status.pools.sort((a, b) => `${a.product} ${a.size}`.localeCompare(`${b.product} ${b.size}`));

    try {
      const historyItems = await redis.lrange('drop_history:archived_logs', 0, -1);
      for (const hist of historyItems) {
        try {
          const parsedHist = JSON.parse(hist);
          combinedCustomerLedger.push({ ...parsedHist, type: parsedHist.type || 'PROCESSED_WINNER_PAID' });
        } catch {}
      }
    } catch {}

    status.fallbackEntriesCount = totalCombinedCount;
    status.fallbackEntries = combinedCustomerLedger.sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime());

    if (typeof globalThis !== 'undefined') {
      (status as any).lastDraw = (globalThis as any).__goyunirLastDraw ?? null;
    }

    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
