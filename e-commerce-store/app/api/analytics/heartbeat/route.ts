import { NextResponse } from 'next/server';
import { createRedisClient, POOL_STATS_KEY } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

const DISPLAY_KEY = 'stats:social_proof_display';
const LAST_BUMP_KEY = 'stats:social_proof_last_bump';

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

    let socialProofDisplay = GOYUNIR_STORE_SUITE.socialProof.baseCount || 0;

    if (redis) {
      if (visitorId) {
        const trafficKey = 'analytics:active_users_online';
        const now = Date.now();
        // One write; cleanup only sometimes to cut commands
        await redis.zadd(trafficKey, { score: now, member: visitorId });
        if (now % 3 === 0) {
          await redis.zremrangebyscore(trafficKey, 0, now - 60 * 1000);
        }
      }

      const trueSub = await sumAllSubs(redis);
      let display = Number((await redis.get(DISPLAY_KEY)) ?? NaN);
      if (!Number.isFinite(display) || display < trueSub) {
        display = trueSub;
        await redis.set(DISPLAY_KEY, String(display));
      }

      if (GOYUNIR_STORE_SUITE.socialProof.autoIncrementEnabled) {
        const lastBump = Number((await redis.get(LAST_BUMP_KEY)) ?? 0);
        const elapsed = Date.now() - lastBump;
        const minGap = 2 * 60 * 60 * 1000;
        const maxGap = 7 * 60 * 60 * 1000;
        // Fixed gap after first roll so we don't re-roll every request
        let requiredGap = Number((await redis.get(LAST_BUMP_KEY + ':gap')) ?? 0);
        if (!requiredGap) {
          requiredGap = minGap + Math.floor(Math.random() * (maxGap - minGap));
          await redis.set(LAST_BUMP_KEY + ':gap', String(requiredGap));
        }
        if (elapsed >= requiredGap) {
          display += 1;
          await redis.set(DISPLAY_KEY, String(display));
          await redis.set(LAST_BUMP_KEY, String(Date.now()));
          const nextGap = minGap + Math.floor(Math.random() * (maxGap - minGap));
          await redis.set(LAST_BUMP_KEY + ':gap', String(nextGap));
        }
      }

      socialProofDisplay = display;
    }

    return NextResponse.json({ socialProofDisplay });
  } catch (err: any) {
    return NextResponse.json({ socialProofDisplay: 0, error: err.message }, { status: 500 });
  }
}