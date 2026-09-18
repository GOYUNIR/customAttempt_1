/**
 * ─────────────────────────────────────────────────────────────────────────────
 * COST UNITS — the pure arithmetic of what the Growth layer spends.
 *
 * Split out from lib/growth/ledger.ts because four different callers need this
 * math and only one of them should be near a database: the send path, the admin
 * margin view, the sales quote calculator, and the tests. Zero imports (mirrors
 * lib/theme-schema.ts / lib/edge-router.ts) so it loads under `node --test` and
 * in the Edge runtime.
 *
 * WHY MICROS. A unit here can be an email at $0.0009 or an LLM token at a
 * fraction of a cent. In cents both round to zero; in floats a million rows
 * drift. Millionths of a cent are exact for every rate we have and stay inside
 * a safe integer for any volume this platform will reach.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Millionths of a cent. */
export type Micros = number;

export const MICROS_PER_CENT = 1_000_000;
export const MICROS_PER_USD = 100_000_000;

export function microsToCents(micros: Micros): number {
  return micros / MICROS_PER_CENT;
}

export function formatMicrosAsUsd(micros: Micros, decimals = 4): string {
  return '$' + (micros / MICROS_PER_USD).toFixed(decimals);
}

/** Cost per thousand units, in dollars — how provider rates are usually quoted. */
export function usdPerThousand(unitCostMicros: Micros): number {
  return (unitCostMicros * 1000) / MICROS_PER_USD;
}

/**
 * First moment of the current UTC month.
 *
 * UTC, not local: an allowance that resets at a different hour per operator
 * makes two people disagree about how much is left, and the provider's own
 * period is not in anyone's local time either.
 */
export function currentPeriodStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type Headroom = {
  unit: string;
  provider: string;
  usedThisPeriod: number;
  includedUnits: number;
  remaining: number;
  percentUsed: number;
  /** Close enough to the allowance to act on. */
  warn: boolean;
  /** Allowance gone: the next unit costs money. */
  exceeded: boolean;
  overageCostPerUnitMicros: Micros;
  sourceUrl: string | null;
};

/** Warn at 80% — enough runway to upgrade or throttle before sends stop. */
export const HEADROOM_WARN_AT = 0.8;

export function computeHeadroom(input: {
  unit: string;
  provider: string;
  used: number;
  includedUnits: number;
  overageCostPerUnitMicros: Micros;
  sourceUrl?: string | null;
}): Headroom {
  const included = Math.max(0, Math.floor(input.includedUnits));
  const used = Math.max(0, Math.floor(input.used));
  const percentUsed = included > 0 ? used / included : 0;
  return {
    unit: input.unit,
    provider: input.provider,
    usedThisPeriod: used,
    includedUnits: included,
    remaining: Math.max(0, included - used),
    percentUsed,
    warn: included > 0 && percentUsed >= HEADROOM_WARN_AT,
    exceeded: included > 0 && used >= included,
    overageCostPerUnitMicros: input.overageCostPerUnitMicros,
    sourceUrl: input.sourceUrl ?? null,
  };
}

/**
 * A sentence an operator can act on, or null when there is nothing to say.
 *
 * Carries the overage PRICE, not just a percentage: "83% used" prompts a shrug,
 * "$0.90 per 1,000 after this" prompts a decision.
 */
export function headroomMessage(h: Headroom): string | null {
  if (!h.warn && !h.exceeded) return null;
  const per1k = usdPerThousand(h.overageCostPerUnitMicros).toFixed(2);
  if (h.exceeded) {
    return (
      h.provider + ' ' + h.unit + ': free allowance EXHAUSTED (' + h.usedThisPeriod + '/' +
      h.includedUnits + ' this month). Every further unit is billable at about $' + per1k +
      ' per 1,000. Upgrade or throttle now.'
    );
  }
  return (
    h.provider + ' ' + h.unit + ': ' + Math.round(h.percentUsed * 100) +
    '% of the free allowance used (' + h.usedThisPeriod + '/' + h.includedUnits + '), ' +
    h.remaining + ' left this month. Overage runs about $' + per1k + ' per 1,000.'
  );
}

/**
 * Gross margin as a percentage, or null when there is no revenue to divide by.
 *
 * Null rather than 0 or 100 on purpose: a tenant paying nothing has no margin,
 * not a perfect one, and reporting 100% for a free account would make the
 * platform-wide number meaningless.
 */
export function marginPercent(revenueMicros: Micros, costMicros: Micros): number | null {
  if (revenueMicros <= 0) return null;
  return ((revenueMicros - costMicros) / revenueMicros) * 100;
}
