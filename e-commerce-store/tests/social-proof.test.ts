import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldIncrementSocialProof,
  dayStartMs,
  HOUR_MS,
} from '../lib/social-proof-core.ts';

const start = Date.UTC(2026, 7, 15); // 2026-08-15T00:00:00Z
const dayStamp = '2026-08-15';

// Helper: `rand` defaults to a dice that ALWAYS MISSES, so any ok-tick has to
// come from a real force (first / min-per-day / max-gap) — chance alone never
// decides unless we inject `rand: () => 0`.
function decide(cfg: Record<string, any> = {}, state: Record<string, any> = {}) {
  const base = {
    now: start + 2 * HOUR_MS,
    last: 0,
    ticksToday: 0,
    dayStamp,
    rand: () => 1,
  };
  const s = { ...base, ...state };
  return shouldIncrementSocialProof(cfg, s);
}

test('dayStartMs parses a YYYY-MM-DD stamp as the UTC day start', () => {
  assert.equal(dayStartMs('2026-08-15'), start);
  assert.equal(dayStartMs('garbage'), 0);
});

test('default hard cap is 4 ticks/day (over-inflation is gone)', () => {
  assert.deepEqual(decide({}, { ticksToday: 4 }), { ok: false, reason: 'daily cap reached' });
  assert.deepEqual(decide({}, { ticksToday: 40 }), { ok: false, reason: 'daily cap reached' });
  // A custom cap is honored when the buyer wants a different ceiling.
  assert.deepEqual(decide({ autoIncrementMaxPerDay: 8 }, { ticksToday: 8 }), {
    ok: false,
    reason: 'daily cap reached',
  });
});

test('default min gap is 2 hours (no rapid re-ticking)', () => {
  const soon = decide({}, { now: start + 3 * HOUR_MS, last: start + 2 * HOUR_MS, ticksToday: 0 });
  assert.equal(soon.ok, false);
  if (!soon.ok) {
    assert.equal(soon.reason, 'too soon');
    assert.equal(soon.nextEligibleInMs, 1 * HOUR_MS);
  }
  // Exactly at the 2h mark the gap is satisfied.
  const atGap = decide({}, { now: start + 4 * HOUR_MS, last: start + 2 * HOUR_MS, ticksToday: 0 });
  assert.equal(atGap.ok, false);
  if (!atGap.ok) assert.equal(atGap.reason, 'chance roll missed');
});

test('fresh Redis (no ticks ever) ticks on the first heartbeat', () => {
  const first = decide({}, { last: 0, ticksToday: 0 });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.force, 'first');
});

test('default max gap forces a tick past 8 hours', () => {
  const stale = decide({}, { now: start + 9 * HOUR_MS, last: start + HOUR_MS / 2, ticksToday: 0 });
  assert.equal(stale.ok, true);
  if (stale.ok) assert.equal(stale.force, 'max-gap');
});

test('default minimum (3/day) is guaranteed by spreading deadlines across the day', () => {
  // minPerDay=3 → tick #1 due by hour 8, #2 by hour 16, #3 by hour 24.
  const pastDeadline1 = decide({}, { now: start + 9 * HOUR_MS, last: start + 2 * HOUR_MS, ticksToday: 0 });
  assert.equal(pastDeadline1.ok, true);
  if (pastDeadline1.ok) assert.equal(pastDeadline1.force, 'min-per-day');

  const beforeDeadline1 = decide({}, { now: start + 7 * HOUR_MS, last: start + 2 * HOUR_MS, ticksToday: 0 });
  assert.equal(beforeDeadline1.ok, false);
  if (!beforeDeadline1.ok) assert.equal(beforeDeadline1.reason, 'chance roll missed');

  const pastDeadline2 = decide({}, { now: start + 17 * HOUR_MS, last: start + 12 * HOUR_MS, ticksToday: 1 });
  assert.equal(pastDeadline2.ok, true);
  if (pastDeadline2.ok) assert.equal(pastDeadline2.force, 'min-per-day');

  // Once the minimum is met it stops forcing (only max-gap / chance remain).
  const minMet = decide({}, { now: start + 25 * HOUR_MS, last: start + 22 * HOUR_MS, ticksToday: 3 });
  assert.equal(minMet.ok, false);
  if (!minMet.ok) assert.equal(minMet.reason, 'chance roll missed');
});

test('min is clamped to max so the settings can never contradict', () => {
  const cfg = { autoIncrementMaxPerDay: 4, autoIncrementMinPerDay: 9 };
  // Effective min=4: tick #4 deadline = start + (24/4)*4 = start+24h → passed.
  const forced = decide(cfg, { now: start + 25 * HOUR_MS, last: start + 23 * HOUR_MS, ticksToday: 3 });
  assert.equal(forced.ok, true);
  if (forced.ok) assert.equal(forced.force, 'min-per-day');
  // The hard cap stays 4 no matter how high min is set.
  assert.deepEqual(decide(cfg, { ticksToday: 4 }), { ok: false, reason: 'daily cap reached' });
});

test('buyers can customize the cadence (min 5 / max 6 / 1h min gap / 12h max gap)', () => {
  const cfg = {
    autoIncrementMaxPerDay: 6,
    autoIncrementMinPerDay: 5,
    autoIncrementMinHourGap: 1,
    autoIncrementMaxHourGap: 12,
  };
  // Custom min gap: 30 minutes is too soon.
  const tooSoon = decide(cfg, { now: start + 2 * HOUR_MS, last: start + HOUR_MS + 30 * 60 * 1000, ticksToday: 4 });
  assert.equal(tooSoon.ok, false);
  if (!tooSoon.ok) assert.equal(tooSoon.reason, 'too soon');
  // Custom min deadline: tick #5 due by hour (24/5)*5 = 24 → passed at hour 29.
  const forced = decide(cfg, { now: start + 29 * HOUR_MS, last: start + 27 * HOUR_MS, ticksToday: 4 });
  assert.equal(forced.ok, true);
  if (forced.ok) assert.equal(forced.force, 'min-per-day');
  // Before the deadline, chance decides.
  const notYet = decide(cfg, { now: start + 3 * HOUR_MS, last: start + HOUR_MS, ticksToday: 4 });
  assert.equal(notYet.ok, false);
  if (!notYet.ok) assert.equal(notYet.reason, 'chance roll missed');
});

test('chance dice is the only gate between the min-gap and the deadline when min=0', () => {
  const cfg = { autoIncrementMinPerDay: 0 };
  const hit = decide(cfg, { now: start + 3 * HOUR_MS, last: start + HOUR_MS, ticksToday: 0, rand: () => 0 });
  assert.equal(hit.ok, true);
  if (hit.ok) assert.equal(hit.force, 'chance');
  const miss = decide(cfg, { now: start + 3 * HOUR_MS, last: start + HOUR_MS, ticksToday: 0, rand: () => 1 });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.equal(miss.reason, 'chance roll missed');
});

test('garbage / NaN config falls back to sane defaults instead of breaking the cap', () => {
  assert.deepEqual(decide({ autoIncrementMaxPerDay: Number.NaN }, { ticksToday: 4 }), {
    ok: false,
    reason: 'daily cap reached',
  });
  const minFallback = decide(
    { autoIncrementMinPerDay: Number.NaN },
    { now: start + 9 * HOUR_MS, last: start + 2 * HOUR_MS, ticksToday: 0 },
  );
  assert.equal(minFallback.ok, true);
  if (minFallback.ok) assert.equal(minFallback.force, 'min-per-day');
});

test('unparsable day stamp degrades safely (min-per-day force instead of a crash)', () => {
  const bad = decide({}, { now: start + 2.5 * HOUR_MS, last: start, ticksToday: 0, dayStamp: 'nope' });
  assert.equal(bad.ok, true);
  if (bad.ok) assert.equal(bad.force, 'min-per-day');
});

test('a simulated day never exceeds 4 ticks with the default cap (always-winning dice)', () => {
  const cfg = {};
  let last = 0;
  let ticksToday = 0;
  let now = start;
  const events: number[] = [];
  const maxIterations = 40;
  for (let i = 0; i < maxIterations; i += 1) {
    const res = shouldIncrementSocialProof(cfg, { now, last, ticksToday, dayStamp, rand: () => 0 });
    if (res.ok) {
      events.push(now);
      last = now;
      ticksToday += 1;
    }
    now += HOUR_MS / 2; // simulate a heartbeat every 30 minutes
  }
  assert.equal(ticksToday, 4, 'hard cap of 4/day is never exceeded even with always-winning dice');
  const gaps = events.slice(1).map((t, i) => t - events[i]);
  assert.ok(gaps.every((g) => g >= 2 * HOUR_MS), 'ticks are never closer than the 2h min gap');
});

