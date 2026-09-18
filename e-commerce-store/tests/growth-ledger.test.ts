import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MICROS_PER_CENT, MICROS_PER_USD, microsToCents, formatMicrosAsUsd, usdPerThousand,
  headroomMessage, currentPeriodStart, computeHeadroom,
} from '../lib/growth/units.ts';

test('micros are millionths of a CENT — the conversion that was wrong by 100x', () => {
  // Resend charges $0.90 per 1,000 emails = $0.0009 each = 0.09 cents each.
  // In millionths of a cent that is 90,000 — NOT 900. The first seed used 900
  // and the error was silent: every margin would have looked 100x better than
  // it was. Asserted against the PUBLISHED per-1,000 price, which is the form
  // the provider actually quotes, so the check survives a re-read of the page.
  const EMAIL = 90_000;
  assert.equal(usdPerThousand(EMAIL).toFixed(2), '0.90');
  assert.equal(formatMicrosAsUsd(EMAIL), '$0.0009');
  assert.equal(microsToCents(EMAIL), 0.09);

  // Supabase egress: $0.09/GB.
  assert.equal(formatMicrosAsUsd(9_000_000, 2), '$0.09');
  // Cloudflare: $0.30 per million requests.
  assert.equal((usdPerThousand(30) * 1000).toFixed(2), '0.30');

  assert.equal(MICROS_PER_CENT, 1_000_000);
  assert.equal(MICROS_PER_USD, 100_000_000);
});

test('the period boundary is the first moment of the UTC month', () => {
  const start = currentPeriodStart(new Date('2026-03-17T14:22:00Z'));
  assert.equal(start, '2026-03-01T00:00:00.000Z');
  // Not local time: an allowance that resets at a different hour per operator
  // would make two people disagree about how much is left.
  assert.equal(currentPeriodStart(new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');
});

test('headroom says nothing until there is something to act on', () => {
  const base = {
    unit: 'email', provider: 'resend', includedUnits: 3000,
    overageCostPerUnitMicros: 90_000, sourceUrl: null,
  };
  assert.equal(headroomMessage({
    ...base, usedThisPeriod: 100, remaining: 2900, percentUsed: 0.033, warn: false, exceeded: false,
  }), null);
});

test('the warning carries the number an operator needs to decide', () => {
  const msg = headroomMessage({
    unit: 'email', provider: 'resend', usedThisPeriod: 2500, includedUnits: 3000,
    remaining: 500, percentUsed: 0.833, warn: true, exceeded: false,
    overageCostPerUnitMicros: 90_000, sourceUrl: null,
  })!;
  assert.match(msg, /83% of the free allowance/);
  assert.match(msg, /500 left/);
  assert.match(msg, /\$0\.90 per 1,000/); // the overage price, not just a percentage
});

test('an exhausted allowance says so plainly — sends stop, not a bill arrives', () => {
  const msg = headroomMessage({
    unit: 'email', provider: 'resend', usedThisPeriod: 3200, includedUnits: 3000,
    remaining: 0, percentUsed: 1.07, warn: true, exceeded: true,
    overageCostPerUnitMicros: 90_000, sourceUrl: null,
  })!;
  assert.match(msg, /EXHAUSTED/);
  assert.match(msg, /3200\/3000/);
  assert.match(msg, /Upgrade or throttle now/);
});
