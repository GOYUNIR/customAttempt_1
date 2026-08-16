/**
 * Self-contained pure decision logic for the social-proof auto-tick engine.
 *
 * This module deliberately has NO imports (not even `@/` aliases) so the
 * browser-free `node --test` runner (`tests/social-proof.test.ts`) can load it
 * directly. `lib/social-proof.ts` wires these decisions into Redis.
 *
 * Default cadence (all overridable from /admin → Draws → Automation → Social
 * Proof Counter):
 *   - min ticks/day: 3  (guaranteed, spread across the day)
 *   - max ticks/day: 4  (hard cap — the counter can never run away)
 *   - ticks spaced 2–8 hours apart (min gap 2h, force a tick past 8h)
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface SocialTickState {
  /** Current epoch ms. */
  now: number;
  /** Epoch ms of the last tick (0 = never ticked — e.g. fresh Redis). */
  last: number;
  /** Ticks already performed today. */
  ticksToday: number;
  /** Current day stamp `YYYY-MM-DD` (UTC) — used to derive the day's start. */
  dayStamp: string;
  /** Injectable randomness for tests (defaults to Math.random). */
  rand?: () => number;
}

export type SocialTickDecision =
  | { ok: true; force: 'first' | 'min-per-day' | 'max-gap' | 'chance' }
  | { ok: false; reason: string; nextEligibleInMs?: number };

function finiteNum(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** Epoch ms of 00:00:00 UTC for a `YYYY-MM-DD` stamp (0 = unparsable). */
export function dayStartMs(dayStamp: string): number {
  const parts = String(dayStamp || '')
    .split('-')
    .map((p) => Number(p));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return 0;
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

/**
 * Decide whether the social-proof counter should tick right now.
 * Pure + deterministic given `state` (inject `rand` in tests).
 */
export function shouldIncrementSocialProof(
  cfg: Record<string, any>,
  state: SocialTickState,
): SocialTickDecision {
  const maxPerDay = Math.max(1, toInt(cfg.autoIncrementMaxPerDay, 4));
  if (state.ticksToday >= maxPerDay) {
    return { ok: false, reason: 'daily cap reached' };
  }

  const minGapHours = Math.max(0, finiteNum(cfg.autoIncrementMinHourGap, 2));
  const maxGapHours = Math.max(minGapHours, finiteNum(cfg.autoIncrementMaxHourGap, 8));
  const minGapMs = minGapHours * HOUR_MS;
  const maxGapMs = maxGapHours * HOUR_MS;

  if (state.last && state.now - state.last < minGapMs) {
    return { ok: false, reason: 'too soon', nextEligibleInMs: minGapMs - (state.now - state.last) };
  }

  const minPerDay = Math.min(maxPerDay, Math.max(0, toInt(cfg.autoIncrementMinPerDay, 3)));

  // Brand-new store / freshly wiped Redis: start drifting immediately (still
  // bounded by the daily max) so the minimum can actually be reached.
  if (state.last === 0 && minPerDay > 0) {
    return { ok: true, force: 'first' };
  }

  // Never let the counter sit quiet past the max gap — keeps it "every 2-8h".
  if (state.last > 0 && state.now - state.last >= maxGapMs) {
    return { ok: true, force: 'max-gap' };
  }

  // Guarantee the daily minimum by spreading it across the day: with minPerDay
  // N, the k-th required tick lands by hour (24/N)*k, so guaranteed ticks end
  // up ~2-8h apart instead of front-loading at dawn.
  if (minPerDay > 0 && state.ticksToday < minPerDay) {
    const start = dayStartMs(state.dayStamp);
    const deadline = start + (DAY_MS / minPerDay) * (state.ticksToday + 1);
    if (!start || state.now >= deadline) {
      return { ok: true, force: 'min-per-day' };
    }
  }

  // Between the min-gap and the deadline, real traffic nudges the counter via
  // a chance dice (rate-limited per IP + the daily cap keep it honest).
  const chance = Math.max(0, Math.min(1, finiteNum(cfg.autoIncrementChancePerHeartbeat, 0.18)));
  const rand = state.rand ?? Math.random;
  if (rand() <= chance) return { ok: true, force: 'chance' };
  return { ok: false, reason: 'chance roll missed' };
}
