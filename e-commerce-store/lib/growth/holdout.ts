/**
 * ─────────────────────────────────────────────────────────────────────────────
 * HOLDOUT ASSIGNMENT — who we deliberately do not contact, so we can prove what
 * contacting the rest was worth.
 *
 * This is the mechanism the whole honest-attribution claim rests on. Every
 * revenue-claiming module (except the deterministic ones — see
 * lib/growth/registry.ts) withholds a small percentage of its audience and
 * compares. The difference between the two groups is what the module ADDED;
 * everything else is a number that counts customers who were going to buy
 * anyway.
 *
 * ASSIGNMENT IS DETERMINISTIC, from a hash of the subject's own id. It stores
 * nothing, and it cannot drift:
 *
 *   - the SAME cart lands in the same group on every run, so a retry or a
 *     second pass never accidentally mails somebody who was supposed to be
 *     held back. A random draw per run would leak the holdout away over time
 *     and quietly turn the comparison into noise.
 *   - it needs no assignment table, so there is no row to get out of sync with
 *     the thing it describes.
 *   - it is reproducible after the fact: given the id, anyone can recompute
 *     which group it was in and check our arithmetic. That is the difference
 *     between a methodology a merchant's accountant can audit and one they have
 *     to take on faith.
 *
 * THE MODULE ID IS PART OF THE HASH, so a customer held out of cart recovery is
 * not automatically held out of back-in-stock too. Without that, the same
 * unlucky people would be excluded from everything and their behaviour would
 * stop resembling the population the control group is meant to represent.
 *
 * Zero imports beyond node:crypto so this can be reasoned about and tested on
 * its own — the arithmetic here decides what we are allowed to claim.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'crypto';

export type HoldoutGroup = 'treated' | 'control';

/**
 * Stable bucket 0-9999 for a subject within one module.
 *
 * A salt is folded in so the buckets cannot be reverse-engineered from a known
 * id, and so the split can be re-randomised later by changing the salt if a
 * cohort ever needs to be redrawn deliberately.
 */
export function holdoutBucket(moduleId: string, subjectId: string, salt = 'growth-v1'): number {
  const digest = createHash('sha256')
    .update(salt + ':' + String(moduleId || '') + ':' + String(subjectId || ''), 'utf8')
    .digest();
  // First 4 bytes as an unsigned int, then reduced. Plenty of entropy for a
  // 0-9999 bucket and stable across platforms.
  return digest.readUInt32BE(0) % 10_000;
}

/**
 * Which group a subject belongs to.
 *
 * A holdout of 0 means the module is not running an experiment at all, and
 * everybody is treated. That is the correct behaviour for a deterministic
 * module (dunning), where withholding a notice to measure it would cost the
 * customer real money.
 */
export function assignHoldout(
  moduleId: string,
  subjectId: string,
  holdoutPercent: number,
  salt?: string,
): HoldoutGroup {
  const pct = Number(holdoutPercent);
  if (!Number.isFinite(pct) || pct <= 0) return 'treated';
  if (pct >= 100) return 'control';
  return holdoutBucket(moduleId, subjectId, salt) < Math.round(pct * 100) ? 'control' : 'treated';
}

/** Convenience for the send path, which only ever asks one question. */
export function isHeldOut(moduleId: string, subjectId: string, holdoutPercent: number, salt?: string): boolean {
  return assignHoldout(moduleId, subjectId, holdoutPercent, salt) === 'control';
}

export type AttributionInput = {
  treatedCount: number;
  controlCount: number;
  treatedRevenueCents: number;
  controlRevenueCents: number;
};

export type AttributionResult = {
  /** Every conversion that touched the module — what competitors report. */
  grossAttributedCents: number;
  /** What the module ADDED, versus the holdout. May be negative. */
  incrementalCents: number;
  /** Revenue per person in each group, the basis of the comparison. */
  treatedPerHead: number;
  controlPerHead: number;
  /** False when the control group is too small to conclude anything. */
  reliable: boolean;
  /** Plain-English note on why, when it is not reliable. */
  caveat: string | null;
};

/**
 * Below this many people in either group, the comparison is noise dressed up as
 * a number. Reporting "we added $4,000" from a control group of nine is how
 * attribution loses an accountant's trust permanently.
 */
export const MIN_GROUP_FOR_CONFIDENCE = 30;

/**
 * Incremental revenue, computed per head rather than as a raw difference.
 *
 * The groups are never exactly the same size — a holdout is a percentage of a
 * varying population — so subtracting raw totals would credit the module for
 * the treated group simply being bigger. Per-head normalises that, then scales
 * back up by the treated population to express the lift in dollars.
 */
export function computeIncremental(input: AttributionInput): AttributionResult {
  const treatedCount = Math.max(0, Math.floor(input.treatedCount));
  const controlCount = Math.max(0, Math.floor(input.controlCount));
  const treatedRevenue = Math.max(0, Math.floor(input.treatedRevenueCents));
  const controlRevenue = Math.max(0, Math.floor(input.controlRevenueCents));

  const treatedPerHead = treatedCount > 0 ? treatedRevenue / treatedCount : 0;
  const controlPerHead = controlCount > 0 ? controlRevenue / controlCount : 0;

  // No control group means no claim. Gross is still reported, because it is a
  // real figure — it just is not evidence of causation.
  if (controlCount === 0) {
    return {
      grossAttributedCents: treatedRevenue,
      incrementalCents: 0,
      treatedPerHead,
      controlPerHead: 0,
      reliable: false,
      caveat: 'No control group ran in this period, so no incremental figure can be claimed.',
    };
  }

  const incrementalCents = Math.round((treatedPerHead - controlPerHead) * treatedCount);
  const tooSmall = treatedCount < MIN_GROUP_FOR_CONFIDENCE || controlCount < MIN_GROUP_FOR_CONFIDENCE;

  return {
    grossAttributedCents: treatedRevenue,
    incrementalCents,
    treatedPerHead,
    controlPerHead,
    reliable: !tooSmall,
    caveat: tooSmall
      ? `Groups are still small (${treatedCount} treated, ${controlCount} held back). Treat this as an early signal, not a result — at least ${MIN_GROUP_FOR_CONFIDENCE} in each is needed before the difference means much.`
      : null,
  };
}

/**
 * The sentence shown next to the numbers in the merchant's dashboard.
 *
 * Written out in full rather than linked to a methodology page, because the
 * claim and its method should not be separable — the whole point is that a
 * merchant can check it without asking us.
 */
export function methodologyNote(holdoutPercent: number, windowHours: number): string {
  return (
    `${holdoutPercent}% of eligible customers were deliberately not contacted, chosen by a ` +
    `stable hash of their id so the same people stay in the same group every time. ` +
    `Revenue is counted for ${windowHours} hours after contact. The incremental figure is the ` +
    `difference in revenue per person between the two groups, multiplied by the number of ` +
    `people contacted.`
  );
}
