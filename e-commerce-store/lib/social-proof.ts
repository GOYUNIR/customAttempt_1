import {
  ANALYTICS_TICKS_KEY,
  TICKS_DAY_FIELD,
  TICKS_LAST_FIELD,
  TICKS_TODAY_FIELD,
  SOCIAL_PROOF_BOOST_KEY,
} from '@/lib/server-config';
import { shouldIncrementSocialProof } from './social-proof-core';

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
 *      entries" counter tick upward through the day — with a hard daily cap,
 *      a guaranteed daily minimum, and a 2–8h spacing window so it drifts
 *      naturally instead of inflating on a script's schedule.
 *
 * Cadence defaults (all admin-overridable via /admin → Draws → Automation →
 * Social Proof Counter): minimum 3 ticks/day, hard cap 4 ticks/day, ticks
 * spaced 2–8 hours apart. All state lives in the single `analytics:ticks`
 * hash (fields `last` / `today` / `day`) so the Redis key space stays tidy.
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
  const newDay = dayStamp !== today;
  // New day → reset the daily tick counter (the boost itself is cumulative).
  if (newDay) {
    await redis.hset(ANALYTICS_TICKS_KEY, {
      [TICKS_DAY_FIELD]: today,
      [TICKS_TODAY_FIELD]: '0',
    });
  }

  const now = Date.now();
  // On a fresh day the pre-reset `todayRaw` is YESTERDAY's count — the daily
  // counter restarts at 0 (this fixes a stale-cap skip on the first hit).
  const ticksToday = newDay ? 0 : Number(todayRaw ?? 0);
  const decision = shouldIncrementSocialProof(cfg, {
    now,
    last: Number(lastRaw ?? 0),
    ticksToday,
    dayStamp: today,
  });
  if (!decision.ok) {
    const out: Record<string, unknown> = { skipped: true, reason: decision.reason };
    if (decision.nextEligibleInMs != null) out.nextEligibleInMs = decision.nextEligibleInMs;
    if (decision.reason === 'daily cap reached') out.ticksToday = ticksToday;
    return out;
  }

  const amount = Number(cfg.autoIncrementAmount ?? 2) * (1 + Math.floor(Math.random() * 3));
  const boost = await redis.incrby(SOCIAL_PROOF_BOOST_KEY, amount);
  await redis.hset(ANALYTICS_TICKS_KEY, { [TICKS_LAST_FIELD]: String(now) });
  await redis.hincrby(ANALYTICS_TICKS_KEY, TICKS_TODAY_FIELD, 1);

  return { ok: true, boost, amount, ticksToday: ticksToday + 1 };
}
