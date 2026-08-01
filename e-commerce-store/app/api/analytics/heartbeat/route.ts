import { NextResponse } from 'next/server';
import { createRedisClient, POOL_STATS_KEY, getSocialProofOverride, SOCIAL_PROOF_BOOST_KEY } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

async function sumAllSubs(redis: any): Promise<number> {
  const stats = (await redis.hgetall(POOL_STATS_KEY)) as Record<string, string> | null;
  if (!stats) return 0;
  let total = 0;
  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
    for (const size of ['50ml', '100ml']) {
      total += Number(stats[`sub:${product.name}:${size}`] ?? 0);
    }
  }
  return Math.max(0, total);
}

export async function GET(request: Request) {
  try {
    const redis = createRedisClient();
    const url = new URL(request.url);
    const visitorId = String(url.searchParams.get('visitorId') || '').slice(0, 64);

    const socialCfg = { ...GOYUNIR_STORE_SUITE.socialProof, ...((redis ? await getSocialProofOverride(redis) : null) || {}) };

    let socialProofDisplay = socialCfg.baseCount || 0;

    if (redis) {
      if (visitorId) {
        const trafficKey = 'analytics:active_users_online';
        const now = Date.now();
        await redis.zadd(trafficKey, { score: now, member: visitorId });
        if (now % 3 === 0) await redis.zremrangebyscore(trafficKey, 0, now - 60 * 1000);
      }

      // Always computed fresh from real numbers — no ratchet, so wins
      // and cancellations correctly SUBTRACT from the displayed count.
      const trueSub = await sumAllSubs(redis);
      const boost = Number((await redis.get(SOCIAL_PROOF_BOOST_KEY)) ?? 0);
      socialProofDisplay = Math.max(0, socialCfg.baseCount + trueSub + boost);
    }

    return NextResponse.json({ socialProofDisplay });
  } catch (err: any) {
    return NextResponse.json({ socialProofDisplay: 0, error: err.message }, { status: 500 });
  }
}