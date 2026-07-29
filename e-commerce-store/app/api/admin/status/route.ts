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

    // 1. EXTRACT REAL-TIME USER TELEMETRY OVER A 5-MINUTE WINDOW
    try {
      const url = new URL(request.url);
      const trafficKey = 'analytics:active_users_online';
      const currentTimeClock = Date.now();

      if (url.searchParams.get('heartbeat') === 'true') {
        const dummyVisitorId = url.searchParams.get('visitorId') || `v_${Math.random().toString(36).substring(7)}`;
        await redis.zadd(trafficKey, { score: currentTimeClock, member: dummyVisitorId });
      }

      // Keep user tracks cached for up to 5 full minutes to account for incognito/mobile delays
      await redis.zremrangebyscore(trafficKey, 0, currentTimeClock - 300 * 1000);
      const totalActiveUsersCount = await redis.zcard(trafficKey);
      status.liveActiveUsersOnline = Math.max(1, totalActiveUsersCount);
    } catch {}

    let totalCombinedCount = 0;
    const combinedCustomerLedger: any[] = [];
    const poolPromises: Promise<void>[] = [];

    // 2. PARSE AND MAP ALL SUBMISSIONS AND INTENTS (CRASH SHIELD APPLIED)
    for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
      for (const size of ['50ml', '100ml']) {
        const poolKey = `drop_pool:${product.name}:${size}`;
        const intentKey = `intent_pool:${product.name}:${size}`;

        const promise = Promise.all([
          redis.llen(poolKey),
          redis.llen(intentKey)
        ]).then(async ([subCount, intCount]) => {
          const sCount = Number(subCount) || 0;
          const iCount = Number(intCount) || 0;
          totalCombinedCount += sCount;

          status.pools.push({
            product: product.name,
            size,
            intCount: iCount,
            subCount: sCount,
            maxLimit: size === '50ml' ? 10 : 5
          });

          const processRows = async (key: string, labelType: 'SUBMISSION' | 'INTENT') => {
            const items = await redis.lrange(key, 0, -1);
            for (const itemStr of items) {
              try {
                let parsed = JSON.parse(itemStr);
                
                // CRITICAL FIX: Recursively unwrap double-nested data properties
                if (parsed && typeof parsed === 'object' && parsed.email && typeof parsed.email === 'object') {
                  parsed = parsed.email;
                }

                combinedCustomerLedger.push({
                  email: String(parsed?.email || parsed?.customer_email || 'Anonymous Client'),
                  variant: product.name,
                  size,
                  shippingAddress: String(parsed?.shippingAddress || parsed?.address || 'No Address Logged'),
                  id: String(parsed?.id || parsed?.stripeCustomerId || 'Active Track Token'),
                  registeredAt: parsed?.registeredAt || parsed?.initiatedAt || new Date().toISOString(),
                  type: labelType
                });
              } catch {
                combinedCustomerLedger.push({
                  email: String(itemStr),
                  variant: product.name,
                  size,
                  shippingAddress: 'Legacy Row Text Block',
                  id: 'Legacy Ref Trace',
                  registeredAt: new Date().toISOString(),
                  type: labelType
                });
              }
            }
          };

          if (sCount > 0) await processRows(poolKey, 'SUBMISSION');
          if (iCount > 0) await processRows(intentKey, 'INTENT');
        }).catch(() => {});

        poolPromises.push(promise);
      }
    }

    await Promise.all(poolPromises);

    // 3. READ PERMANENT HISTORY DIRECTLY SO DEPLOYED LAUNCHES NEVER DISAPPEAR
    try {
      const historyItems = await redis.lrange('drop_history:archived_logs', 0, -1);
      for (const hist of historyItems) {
        try {
          const parsedHist = JSON.parse(hist);
          combinedCustomerLedger.push({
            ...parsedHist,
            type: parsedHist.type || 'ARCHIVED_WINNER'
          });
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
