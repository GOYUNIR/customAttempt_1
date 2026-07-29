import { NextResponse } from 'next/server';
import { createRedisClient } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ liveActiveUsersOnline: 1, fallbackEntriesCount: 0 });
  }
  try {
    const url = new URL(request.url);
    const trafficKey = 'analytics:active_users_online';
    const now = Date.now();
    const visitorId = url.searchParams.get('visitorId');

    if (visitorId) {
      await redis.zadd(trafficKey, { score: now, member: visitorId });
    }
    await redis.zremrangebyscore(trafficKey, 0, now - 30 * 1000);
    const liveActiveUsersOnline = Math.max(1, await redis.zcard(trafficKey));

    let fallbackEntriesCount = 0;
    for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
      for (const size of ['50ml', '100ml']) {
        fallbackEntriesCount += await redis.llen(`drop_pool:${product.name}:${size}`);
      }
    }

    return NextResponse.json({ liveActiveUsersOnline, fallbackEntriesCount });
  } catch {
    return NextResponse.json({ liveActiveUsersOnline: 1, fallbackEntriesCount: 0 });
  }
}