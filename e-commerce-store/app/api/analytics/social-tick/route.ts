import { NextResponse } from 'next/server';
import { createRedisClient, SOCIAL_PROOF_BOOST_KEY } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

const LAST_TICK_KEY = 'stats:social_proof_last_tick';

export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { autoIncrementEnabled, autoIncrementAmount } = GOYUNIR_STORE_SUITE.socialProof;
  if (!autoIncrementEnabled) {
    return NextResponse.json({ skipped: true, reason: 'disabled' });
  }

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ skipped: true, reason: 'no redis' });

  const now = Date.now();
  const last = Number((await redis.get(LAST_TICK_KEY)) ?? 0);
  const minGap = 30 * 60 * 1000;
  const maxGap = 2 * 60 * 60 * 1000;
  const nextGap = minGap + Math.floor(Math.random() * (maxGap - minGap));

  if (last && now - last < nextGap) {
    return NextResponse.json({
      skipped: true,
      reason: 'too soon',
      nextEligibleInMs: nextGap - (now - last),
    });
  }

  const amount = autoIncrementAmount * (1 + Math.floor(Math.random() * 3));
  const boost = await redis.incrby(SOCIAL_PROOF_BOOST_KEY, amount);
  await redis.set(LAST_TICK_KEY, String(now));

  return NextResponse.json({ success: true, boost, added: amount });
}