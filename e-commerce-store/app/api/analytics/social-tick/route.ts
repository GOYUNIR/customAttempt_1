import { NextResponse } from 'next/server';
import { createRedisClient, SOCIAL_PROOF_BOOST_KEY, getSocialProofOverride } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

const LAST_TICK_KEY = 'stats:social_proof_last_tick';
const TICKS_TODAY_KEY = 'stats:social_proof_ticks_today';
const TICKS_DAY_STAMP_KEY = 'stats:social_proof_ticks_day_stamp';

function authorized(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET || process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (!secret) return true;
  const auth = request.headers.get('authorization');
  const key = url.searchParams.get('key') || '';
  if (request.headers.get('x-vercel-cron') === '1') return true;
  if (auth === `Bearer ${secret}`) return true;
  if (key === secret) return true;
  return false;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ skipped: true, reason: 'no redis' });

  const cfg = {
    ...GOYUNIR_STORE_SUITE.socialProof,
    ...((await getSocialProofOverride(redis)) || {}),
  };
  if (!cfg.autoIncrementEnabled) {
    return NextResponse.json({ skipped: true, reason: 'disabled' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const dayStamp = await redis.get(TICKS_DAY_STAMP_KEY);
  if (dayStamp !== today) {
    await redis.set(TICKS_DAY_STAMP_KEY, today);
    await redis.set(TICKS_TODAY_KEY, '0');
  }

  const ticksToday = Number((await redis.get(TICKS_TODAY_KEY)) ?? 0);
  if (ticksToday >= (cfg.autoIncrementMaxPerDay ?? 4)) {
    return NextResponse.json({ skipped: true, reason: 'daily cap reached', ticksToday });
  }

  const now = Date.now();
  const last = Number((await redis.get(LAST_TICK_KEY)) ?? 0);
  const minGapMs = (cfg.autoIncrementMinHourGap ?? 3) * 60 * 60 * 1000;
  if (last && now - last < minGapMs) {
    return NextResponse.json({
      skipped: true,
      reason: 'too soon',
      nextEligibleInMs: minGapMs - (now - last),
    });
  }

  if (Math.random() > (cfg.autoIncrementChancePerHeartbeat ?? 0.15)) {
    return NextResponse.json({ skipped: true, reason: 'chance roll missed' });
  }

  const amount = (cfg.autoIncrementAmount ?? 1) * (1 + Math.floor(Math.random() * 3));
  const boost = await redis.incrby(SOCIAL_PROOF_BOOST_KEY, amount);
  await redis.set(LAST_TICK_KEY, String(now));
  await redis.incr(TICKS_TODAY_KEY);

  return NextResponse.json({ ok: true, boost, amount, ticksToday: ticksToday + 1 });
}