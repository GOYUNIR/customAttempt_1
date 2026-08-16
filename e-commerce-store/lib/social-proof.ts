import {
  ANALYTICS_TICKS_KEY,
  TICKS_DAY_FIELD,
  TICKS_LAST_FIELD,
  TICKS_TODAY_FIELD,
  SOCIAL_PROOF_BOOST_KEY,
} from '@/lib/server-config';

/**
 * The social-proof auto-increment engine. Shared by BOTH triggers so the
 * counter can only ever grow through one code path:
 *
 *   1. `/api/analytics/social-tick` — the authenticated cron route (Vercel
 *      Hobby allows max one run per day, so on its own it can never make the
 *      counter "inflate through the day").
 *   2. `/api/analytics/heartbeat` — the PUBLIC route the home page calls on
 *      every load (rate-limited 120/min/IP). Each heartbeat rolls the same
 *      dice the cron used, so real visitor traffic makes the "total raffle
 *      entries" counter tick upward through the day — with hard daily caps so
 *      it can never run away or be scripted into a fake explosion.
 *
 * All state lives in the single `analytics:ticks` hash (fields `last` /
 * `today` / `day`) so the Redis key space stays tidy. Reads are cheap and the
 * heartbeat path already rate-limits abuse.
 */
export async function maybeAutoIncrementSocialProof(
  redis: any,
  cfg: Record<string, any>,
): Promise<Record<string, unknown>> {
  if (!redis) return { skipped: true, reason: 'no redis' };
  if (cfg.autoIncrementEnabled === false) return { skipped: true, reason: 'disabled' };

  const today = new Date().toISOString().slice(0, 10);
  const [dayStamp, todayRaw, lastRaw] = await Promise.all([
    redis.hget(ANALYTICS_TICKS_KEY, TICKS_DAY_FIELD).catch(() => null),
    redis.hget(ANALYTICS_TICKS_KEY, TICKS_TODAY_FIELD).catch(() => null),
    redis.hget(ANALYTICS_TICKS_KEY, TICKS_LAST_FIELD).catch(() => null),
  ]);
  // New day → reset the daily tick counter (the boost itself is cumulative).
  if (dayStamp !== today) {
    await redis.hset(ANALYTICS_TICKS_KEY, {
      [TICKS_DAY_FIELD]: today,
      [TICKS_TODAY_FIELD]: '0',
    });
  }

  const ticksToday = Number(todayRaw ?? 0);
  const maxPerDay = Math.max(1, Number(cfg.autoIncrementMaxPerDay ?? 15));
  if (ticksToday >= maxPerDay) {
    return { skipped: true, reason: 'daily cap reached', ticksToday };
  }

  const now = Date.now();
  const last = Number(lastRaw ?? 0);
  const minGapMs = Math.max(0, Number(cfg.autoIncrementMinHourGap ?? 1)) * 60 * 60 * 1000;
  const maxGapMs = Math.max(minGapMs, Number(cfg.autoIncrementMaxHourGap ?? 8) * 60 * 60 * 1000);
  if (last && now - last < minGapMs) {
    return { skipped: true, reason: 'too soon', nextEligibleInMs: minGapMs - (now - last) };
  }

  // When the counter has been quiet for a long time it is FORCED to tick so a
  // low-traffic store still drifts upward; otherwise it rolls a chance dice.
  const forceDueToMaxGap = last > 0 && now - last >= maxGapMs;
  if (!forceDueToMaxGap && Math.random() > Number(cfg.autoIncrementChancePerHeartbeat ?? 0.18)) {
    return { skipped: true, reason: 'chance roll missed' };
  }

  const amount = Number(cfg.autoIncrementAmount ?? 2) * (1 + Math.floor(Math.random() * 3));
  const boost = await redis.incrby(SOCIAL_PROOF_BOOST_KEY, amount);
  await redis.hset(ANALYTICS_TICKS_KEY, { [TICKS_LAST_FIELD]: String(now) });
  await redis.hincrby(ANALYTICS_TICKS_KEY, TICKS_TODAY_FIELD, 1);

  return { ok: true, boost, amount, ticksToday: ticksToday + 1 };
}
