import { NextResponse } from 'next/server';
import { createRedisClient, POOL_STATS_KEY, getSocialProofOverride, SOCIAL_PROOF_BOOST_KEY, ANALYTICS_ONLINE_KEY } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { withTtlCache } from '@/lib/ttl-cache';
import { isRateLimited } from '@/lib/rate-limit';
import { maybeAutoIncrementSocialProof } from '@/lib/social-proof';

export const dynamic = 'force-dynamic';

async function sumAllSubs(redis: any): Promise<number> {
  const stats = (await redis.hgetall(POOL_STATS_KEY)) as Record<string, string> | null;
  if (!stats) return 0;
  let total = 0;
  for (const [field, value] of Object.entries(stats)) {
    if (!field.startsWith('sub:')) continue;
    total += Number(value ?? 0);
  }
  return Math.max(0, total);
}

export async function GET(request: Request) {
  try {
    // Heartbeats fire on page load + periodically; a very generous per-IP cap
    // stops a script from inflating the online-visitor / social-proof tallies
    // without ever tripping a normal multi-tab visitor.
    if (await isRateLimited('heartbeat', request, 120, 60)) {
      return NextResponse.json({ socialProofDisplay: 0 });
    }

    const redis = createRedisClient();
    const url = new URL(request.url);
    const visitorId = String(url.searchParams.get('visitorId') || '').slice(0, 64);

    const socialCfg = { ...GOYUNIR_STORE_SUITE.socialProof, ...((redis ? await getSocialProofOverride(redis) : null) || {}) };

    let socialProofDisplay = socialCfg.baseCount || 0;

    if (redis) {
      if (visitorId) {
        const trafficKey = ANALYTICS_ONLINE_KEY;
        const now = Date.now();
        await redis.zadd(trafficKey, { score: now, member: visitorId });
        if (now % 3 === 0) await redis.zremrangebyscore(trafficKey, 0, now - 60 * 1000);
      }

      // "Total raffle entries" inflates through the day WITH the traffic: each
      // heartbeat rolls the same capped dice the cron used to, so real visitors
      // nudge the counter upward on their own (rate-limited per IP + hard daily
      // caps inside the shared engine keep it honest). No cron required.
      try {
        await maybeAutoIncrementSocialProof(redis, socialCfg);
      } catch (err) {
        console.error('[heartbeat] social auto-increment failed', err instanceof Error ? err.message : String(err));
      }

      // The entry/subscription tally is recomputed on every page load today;
      // cache the read-heavy tally for a few seconds so repeat requests are
      // cheap while still reflecting new entries within the TTL.
      const tally = await withTtlCache('analytics:social-proof-tally:v1', 15_000, async () => {
        const trueSub = await sumAllSubs(redis);
        const boost = Number((await redis.get(SOCIAL_PROOF_BOOST_KEY)) ?? 0);
        return { trueSub, boost };
      });
      socialProofDisplay = Math.max(0, socialCfg.baseCount + tally.trueSub + tally.boost);
    }

    return NextResponse.json({ socialProofDisplay });
  } catch (err: any) {
    console.error('[heartbeat] failed', err?.message || err);
    return NextResponse.json({ socialProofDisplay: 0 });
  }
}