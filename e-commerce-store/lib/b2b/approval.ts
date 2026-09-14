/**
 * ─────────────────────────────────────────────────────────────────────────────
 * B2B APPROVAL WORKFLOWS — spend-threshold routing.
 *
 * Pure decision logic (see lib/b2b/pricing.ts's header for why: zero
 * imports, `node --test`-loadable) over `public.approval_rules` /
 * `public.company_members` (supabase/migrations/00009). Decides WHETHER an
 * order needs approval and WHO is eligible to approve it; persistence
 * (creating the `order_approvals` row, notifying the approver) is an
 * ordinary Supabase-REST call site built on top of this.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface ApprovalRule {
  id: string;
  companyId: string;
  thresholdCents: number;
  approverRole: 'approver' | 'manager';
}

export interface CompanyMember {
  userId: string;
  companyId: string;
  role: 'buyer' | 'approver' | 'manager';
  /** Per-buyer spend cap in cents; null = no individual cap (only the
   *  company-wide rule threshold applies). */
  spendLimitCents: number | null;
}

export interface ApprovalDecision {
  requiresApproval: boolean;
  /** The rule that triggered approval (highest threshold at/under the order
   *  total among this company's rules), or null when none applied. */
  triggeredRule: ApprovalRule | null;
  /** Company members eligible to decide (role matches the triggered rule's
   *  `approverRole`, or 'manager' — managers can always approve regardless
   *  of which role a rule names, since 'manager' is the senior B2B role). */
  eligibleApproverUserIds: string[];
}

/**
 * Decide whether `orderSubtotalCents` needs approval for `companyId`, and
 * who may approve it. Two independent gates can trigger approval:
 *   1. A company-wide `approval_rules` threshold (the order total, at/above
 *      the rule's `thresholdCents`).
 *   2. An individual buyer's own `spendLimitCents` (set on their
 *      `company_members` row) — even below the company threshold, a buyer
 *      can't exceed their own personal cap.
 *
 * When multiple company rules qualify, the one with the HIGHEST threshold
 * that the order still meets/exceeds wins (the strictest applicable gate).
 */
export function evaluateOrderApproval(
  orderSubtotalCents: number,
  companyId: string,
  rules: ApprovalRule[],
  members: CompanyMember[],
  requestingBuyerUserId?: string,
): ApprovalDecision {
  const total = Number.isFinite(orderSubtotalCents) && orderSubtotalCents > 0 ? orderSubtotalCents : 0;
  const companyRules = (Array.isArray(rules) ? rules : []).filter(
    (r) => r && r.companyId === companyId && Number.isFinite(r.thresholdCents) && r.thresholdCents >= 0,
  );
  const companyMembers = (Array.isArray(members) ? members : []).filter((m) => m && m.companyId === companyId);

  const qualifyingRules = companyRules.filter((r) => total >= r.thresholdCents);
  const ruleTriggered = qualifyingRules.length > 0
    ? qualifyingRules.reduce((a, b) => (b.thresholdCents > a.thresholdCents ? b : a))
    : null;

  const buyer = requestingBuyerUserId
    ? companyMembers.find((m) => m.userId === requestingBuyerUserId)
    : undefined;
  const buyerCapExceeded = Boolean(
    buyer && typeof buyer.spendLimitCents === 'number' && total > buyer.spendLimitCents,
  );

  const requiresApproval = Boolean(ruleTriggered) || buyerCapExceeded;
  if (!requiresApproval) {
    return { requiresApproval: false, triggeredRule: null, eligibleApproverUserIds: [] };
  }

  // A buyer-cap-only trigger (no company rule qualified) still needs SOME
  // approver — any manager, or any approver, since there's no rule naming a
  // specific role to defer to.
  const requiredRole = ruleTriggered?.approverRole ?? null;
  const eligible = companyMembers.filter((m) => {
    if (m.role === 'manager') return true; // managers can always approve
    if (requiredRole) return m.role === requiredRole;
    return m.role === 'approver';
  });

  return {
    requiresApproval: true,
    triggeredRule: ruleTriggered,
    eligibleApproverUserIds: eligible.map((m) => m.userId),
  };
}
