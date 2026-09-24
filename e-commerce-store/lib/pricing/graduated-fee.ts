/**
 * GRADUATED PLATFORM FEE — "you pay what the cheapest plan would have cost for
 * the month you actually had", collected one sale at a time.
 *
 * Every priced plan is a straight cost line in monthly sales volume V:
 *
 *     cost(V) = monthly price + fee rate × V
 *
 * The graduated fee for the month is the LOWEST of those lines at the volume
 * the merchant actually did — the lower envelope. Because the plans include a
 * free one (price 0), the envelope starts at zero, and because it is a minimum
 * of straight lines it only ever bends downward. That shape has one property
 * that makes the whole design work:
 *
 *   Charging each sale the INCREASE in the envelope it causes adds up, over
 *   the month, to exactly the envelope at the month's total — however the
 *   volume was split into sales, in whatever order.
 *
 * So the fee can be taken per charge (Stripe Connect's application fee), with
 * no end-of-month true-up, no refund-of-overcharge, and no moment where a
 * merchant is billed more than the cheapest plan for their month. The marginal
 * rate a sale pays is simply the slope of the envelope where the month-to-date
 * volume sits: the free plan's rate at first, then each cheaper-per-sale plan's
 * rate as volume makes it the better deal, then zero once the flat-price plan
 * is cheapest outright.
 *
 * NOTHING HERE IS A PRICE. Plans, prices and rates come in as data (the
 * pricing data / public.plans), so the breakpoints move automatically when a
 * price changes — they are derived, never configured, and cannot drift from
 * the published plans.
 *
 * INTEGER MONEY. Everything is exact integer arithmetic: basis points and
 * cents, scaled by 10,000 so no rate or breakpoint is ever a float. Rounding
 * happens only when turning the month-to-date envelope into whole cents, and
 * each fee is the difference of two rounded totals — which is what keeps the
 * sum of per-sale fees equal to the rounded monthly total exactly.
 *
 * Pure, with relative imports only, so the node test runner can load it.
 */

export type FeePlan = {
  id: string;
  /** Monthly price in cents. Plans without a published price are excluded. */
  monthlyCents: number | null;
  /** Platform fee in basis points (200 = 2%). */
  feeBps: number;
};

export type FeeTier = {
  /** This tier applies from this month-to-date volume (cents, inclusive)... */
  fromCents: number;
  /** ...up to this volume (cents, exclusive). null = no upper bound. */
  toCents: number | null;
  /** Marginal rate within the tier, in basis points. */
  bps: number;
  /** The plan whose cost line forms this stretch of the envelope. */
  planId: string;
};

type Line = { id: string; m10k: bigint; bps: bigint };

function linesOf(plans: FeePlan[]): Line[] {
  const lines = plans
    .filter((p) => p.monthlyCents !== null && Number.isFinite(p.monthlyCents) && Number.isFinite(p.feeBps))
    .map((p) => ({
      id: p.id,
      // Scaled by 10,000 so price and rate × volume share one integer unit.
      m10k: BigInt(Math.round(Number(p.monthlyCents))) * BigInt(10000),
      bps: BigInt(Math.round(p.feeBps)),
    }));
  if (lines.length === 0) throw new Error('graduated fee: no priced plans');
  if (!lines.some((l) => l.m10k === BigInt(0))) {
    // A per-sale fee cannot collect a fixed monthly charge: with no free plan
    // the envelope does not start at zero and the whole scheme stops adding up.
    throw new Error('graduated fee: needs a plan with a monthly price of 0');
  }
  if (lines.some((l) => l.bps < BigInt(0) || l.m10k < BigInt(0))) throw new Error('graduated fee: negative price or rate');
  return lines;
}

/** Envelope at volume V, in cents × 10,000 (exact). */
function envelope10k(lines: Line[], volumeCents: bigint): bigint {
  let best: bigint | null = null;
  for (const l of lines) {
    const cost = l.m10k + l.bps * volumeCents;
    if (best === null || cost < best) best = cost;
  }
  return best as bigint;
}

/** Round a cents×10,000 amount to whole cents, half up (amounts are never negative). */
function toCents(v10k: bigint): number {
  return Number((v10k + BigInt(5000)) / BigInt(10000));
}

/** The whole month's graduated fee at a given month-to-date volume, in cents. */
export function monthlyFeeCents(plans: FeePlan[], volumeCents: number): number {
  const v = BigInt(Math.max(0, Math.floor(volumeCents)));
  return toCents(envelope10k(linesOf(plans), v));
}

/**
 * The fee for ONE charge: the increase in the month's graduated fee that this
 * charge causes. `monthToDateCents` is the merchant's sales volume this month
 * BEFORE this charge. Summed over the month, these equal monthlyFeeCents at
 * the month's total exactly.
 */
export function feeForChargeCents(plans: FeePlan[], monthToDateCents: number, amountCents: number): number {
  const before = Math.max(0, Math.floor(monthToDateCents));
  const amount = Math.max(0, Math.floor(amountCents));
  return monthlyFeeCents(plans, before + amount) - monthlyFeeCents(plans, before);
}

/**
 * The schedule, for showing a merchant: which rate applies over which band of
 * monthly volume. Derived from the envelope — every band is a stretch where one
 * plan's cost line is the cheapest. Breakpoints are rounded UP to whole cents
 * for display; the fee itself never uses them (it uses the exact envelope).
 */
export function graduatedSchedule(plans: FeePlan[]): FeeTier[] {
  const lines = linesOf(plans);
  const tiers: FeeTier[] = [];
  // Start on the cheapest line at zero volume; among ties, the higher rate
  // (it is cheapest just above zero only if nothing lower-rate ties at 0).
  let current = lines
    .filter((l) => l.m10k === BigInt(0))
    .sort((a, b) => (a.bps < b.bps ? -1 : a.bps > b.bps ? 1 : 0))[0];
  let fromNum = BigInt(0); // breakpoint as an exact fraction num/den (cents)
  let fromDen = BigInt(1);
  for (let guard = 0; guard < lines.length + 1; guard += 1) {
    // Next line: lower rate, intersecting soonest after the current start.
    let next: Line | null = null;
    let bestNum = BigInt(0);
    let bestDen = BigInt(1);
    for (const l of lines) {
      if (l.bps >= current.bps) continue;
      // m_c + b_c V = m_l + b_l V  ->  V = (m_l - m_c) / (b_c - b_l)
      const num = l.m10k - current.m10k;
      const den = current.bps - l.bps;
      if (num * fromDen < fromNum * den) continue; // intersects before our start
      if (next === null || num * bestDen < bestNum * den) {
        next = l;
        bestNum = num;
        bestDen = den;
      }
    }
    const fromCents = Number((fromNum + fromDen - BigInt(1)) / fromDen);
    if (!next) {
      tiers.push({ fromCents, toCents: null, bps: Number(current.bps), planId: current.id });
      break;
    }
    const toCents = Number((bestNum + bestDen - BigInt(1)) / bestDen);
    if (toCents > fromCents) tiers.push({ fromCents, toCents, bps: Number(current.bps), planId: current.id });
    current = next;
    fromNum = bestNum;
    fromDen = bestDen;
  }
  return tiers;
}

/**
 * Where a merchant stands this month — the numbers behind the "approaching
 * milestone" card. Effective rate is the month's fee over its volume.
 */
export function monthStanding(plans: FeePlan[], monthToDateCents: number) {
  const v = Math.max(0, Math.floor(monthToDateCents));
  const tiers = graduatedSchedule(plans);
  const tier = tiers.find((t) => v >= t.fromCents && (t.toCents === null || v < t.toCents)) || tiers[tiers.length - 1];
  const next = tiers[tiers.indexOf(tier) + 1] || null;
  const feeCents = monthlyFeeCents(plans, v);
  return {
    volumeCents: v,
    feeCents,
    effectiveBps: v > 0 ? Math.round((feeCents * 10000) / v) : tier.bps,
    currentBps: tier.bps,
    nextBps: next ? next.bps : null,
    /** Sales still to go this month before the next, lower rate starts. */
    toNextTierCents: next ? Math.max(0, next.fromCents - v) : null,
    /** True once the flat-price ceiling is reached: further sales this month are fee-free. */
    atCeiling: tier.bps === 0,
  };
}
