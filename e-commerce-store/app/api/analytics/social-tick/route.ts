import { NextResponse } from 'next/server';
import { createRedisClient, SOCIAL_PROOF_BOOST_KEY, getSocialProofOverride, getAdminPassword, ANALYTICS_TICKS_KEY, TICKS_LAST_FIELD, TICKS_TODAY_FIELD, TICKS_DAY_FIELD } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

function authorized(request: Request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET || getAdminPassword();
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
  // The ticker state lives in ONE hash (`analytics:ticks`) so the analytics
  // namespace stays tidy — day stamp, today counter and last-tick timestamp
  // are just three fields of the same key.
  const [dayStamp, todayRaw, lastRaw] = await Promise.all([
    redis.hget(ANALYTICS_TICKS_KEY, TICKS_DAY_FIELD).catch(() => null),
    redis.hget(ANALYTICS_TICKS_KEY, TICKS_TODAY_FIELD).catch(() => null),
    redis.hget(ANALYTICS_TICKS_KEY, TICKS_LAST_FIELD).catch(() => null),
  ]);
  if (dayStamp !== today) {
    await redis.hset(ANALYTICS_TICKS_KEY, {
      [TICKS_DAY_FIELD]: today,
      [TICKS_TODAY_FIELD]: '0',
    });
  }

  const ticksToday = Number(todayRaw ?? 0);
  if (ticksToday >= (cfg.autoIncrementMaxPerDay ?? 4)) {
    return NextResponse.json({ skipped: true, reason: 'daily cap reached', ticksToday });
  }

  const now = Date.now();
  const last = Number(lastRaw ?? 0);
  const minGapMs = (cfg.autoIncrementMinHourGap ?? 3) * 60 * 60 * 1000;
  const maxGapMs = Math.max(minGapMs, (cfg.autoIncrementMaxHourGap ?? 8) * 60 * 60 * 1000);
  if (last && now - last < minGapMs) {
    return NextResponse.json({
      skipped: true,
      reason: 'too soon',
      nextEligibleInMs: minGapMs - (now - last),
    });
  }

  const forceDueToMaxGap = last > 0 && now - last >= maxGapMs;
  if (!forceDueToMaxGap && Math.random() > (cfg.autoIncrementChancePerHeartbeat ?? 0.15)) {
    return NextResponse.json({ skipped: true, reason: 'chance roll missed' });
  }

  const amount = (cfg.autoIncrementAmount ?? 1) * (1 + Math.floor(Math.random() * 3));
  const boost = await redis.incrby(SOCIAL_PROOF_BOOST_KEY, amount);
  await redis.hset(ANALYTICS_TICKS_KEY, {
    [TICKS_LAST_FIELD]: String(now),
  });
  await redis.hincrby(ANALYTICS_TICKS_KEY, TICKS_TODAY_FIELD, 1);

  return NextResponse.json({ ok: true, boost, amount, ticksToday: ticksToday + 1 });
}