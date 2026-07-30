import { NextResponse } from 'next/server';
import { createRedisClient, POOL_STATS_KEY, SOCIAL_PROOF_BOOST_KEY } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const redis = createRedisClient();
  const baseCount = GOYUNIR_STORE_SUITE.socialProof.baseCount;
  if (!redis) {
    return NextResponse.json({ liveActiveUsersOnline: 1, socialProofDisplay: baseCount });
  }
  try {
    const url = new URL(request.url);
    const trafficKey = 'analytics:active_users_online';
    const now = Date.now();
    const visitorId = url.searchParams.get('visitorId');
    if (visitorId) await redis.zadd(trafficKey, { score: now, member: visitorId });
    await redis.zremrangebyscore(trafficKey, 0, now - 45 * 1000);
    const liveActiveUsersOnline = Math.max(1, await redis.zcard(trafficKey));

    const statsHash = (await redis.hgetall(POOL_STATS_KEY)) as Record<string, string> | null;
    let confirmedSubs = 0;
    for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
      for (const size of ['50ml', '100ml']) {
        confirmedSubs += Number(statsHash?.[`sub:${product.name}:${size}`] ?? 0);
      }
    }

    let boost = 0;
    const { autoIncrementEnabled, autoIncrementChancePerHeartbeat, autoIncrementAmount } = GOYUNIR_STORE_SUITE.socialProof;
    if (autoIncrementEnabled && Math.random() < autoIncrementChancePerHeartbeat) {
      boost = await redis.incrby(SOCIAL_PROOF_BOOST_KEY, autoIncrementAmount);
    } else {
      boost = Number((await redis.get(SOCIAL_PROOF_BOOST_KEY)) ?? 0);
    }

    const socialProofDisplay = baseCount + confirmedSubs + boost;
    return NextResponse.json({ liveActiveUsersOnline, socialProofDisplay });
  } catch {
    return NextResponse.json({ liveActiveUsersOnline: 1, socialProofDisplay: baseCount });
  }
}