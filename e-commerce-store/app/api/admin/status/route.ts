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
      liveActiveUsersOnline: 0 // Injected real-time user counter metric parameter fields
    };

    if (!redis) {
      return NextResponse.json(status);
    }

    // 1. CALCULATE ANONYMOUS REAL-TIME HEARTBEAT TELEMETRY TRAFFIC
    try {
      const url = new URL(request.url);
      const isHeartbeatPing = url.searchParams.get('heartbeat') === 'true';
      const trafficKey = 'analytics:active_users_online';
      const currentTimeClock = Date.now();

      if (isHeartbeatPing) {
        const dummyVisitorId = url.searchParams.get('visitorId') || `v_${Math.random().toString(36).substring(7)}`;
        await redis.zadd(trafficKey, { score: currentTimeClock, member: dummyVisitorId });
      }

      // Sweep and remove any historical records older than 30 seconds ago to keep data pure
      const cutoffTimeThreshold = currentTimeClock - 30 * 1000;
      await redis.zremrangebyscore(trafficKey, 0, cutoffTimeThreshold);
      
      const totalActiveUsersCount = await redis.zcard(trafficKey);
      status.liveActiveUsersOnline = Math.max(1, totalActiveUsersCount);
    } catch {}

    // 2. AGGREGATE POOLS AND REGISTRANT META DATA
    let totalCombinedCount = 0;
    const combinedCustomerLedger: any[] = [];
    const poolPromises: Promise<void>[] = [];

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

          if (sCount > 0) {
            const rawSubs = await redis.lrange(poolKey, 0, -1);
            for (const itemStr of rawSubs) {
              try {
                const parsed = JSON.parse(itemStr);
                combinedCustomerLedger.push({
                  email: parsed.email || 'Anonymous',
                  variant: product.name,
                  size,
                  shippingAddress: parsed.shippingAddress || 'No Address Logged',
                  id: parsed.id || parsed.stripeCustomerId || 'Active Track',
                  registeredAt: parsed.registeredAt || new Date().toISOString(),
                  type: parsed.type || 'SUBMISSION'
                });
              } catch {
                combinedCustomerLedger.push({ email: itemStr, variant: product.name, size, type: 'SUBMISSION', id: 'Legacy Row', shippingAddress: 'No Address Logged', registeredAt: new Date().toISOString() });
              }
            }
          }

          if (iCount > 0) {
            const rawIntents = await redis.lrange(intentKey, 0, -1);
            for (const itemStr of rawIntents) {
              try {
                const parsed = JSON.parse(itemStr);
                combinedCustomerLedger.push({
                  email: parsed.email || 'Anonymous',
                  variant: product.name,
                  size,
                  shippingAddress: parsed.shippingAddress || 'Form Input Captured',
                  id: 'Pending Authorization Hold',
                  registeredAt: parsed.registeredAt || new Date().toISOString(),
                  type: 'INTENT'
                });
              } catch {
                combinedCustomerLedger.push({ email: itemStr, variant: product.name, size, type: 'INTENT', id: 'Incomplete Intent', shippingAddress: 'Form Input Captured', registeredAt: new Date().toISOString() });
              }
            }
          }
        }).catch(() => {});

        poolPromises.push(promise);
      }
    }

    await Promise.all(poolPromises);
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
