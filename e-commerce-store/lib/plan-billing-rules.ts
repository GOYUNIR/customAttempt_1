/**
 * PLAN BILLING RULES — the decisions lib/plan-billing.ts makes, with no I/O so
 * they are tested directly (tests/plan-billing.test.ts).
 */

const RANK: Record<string, number> = { active: 0, trialing: 0, past_due: 1, unpaid: 2 };

/**
 * Of a customer's plan subscriptions, the one that decides the plan: paying
 * beats failing beats ended; ties go to the newest. With none live, the
 * evented subscription (so a cancel still lands). An owner who paid twice (two
 * Checkout tabs) and cancels one stays on the plan the other still pays for.
 */
export function governing(subs: any[], evented: any): any {
  const live = subs
    .filter((s) => s?.metadata?.tenant_id === evented?.metadata?.tenant_id && Object.hasOwn(RANK, String(s.status)))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || Number(b.created || 0) - Number(a.created || 0));
  return live[0] || evented;
}

/**
 * The store's plan and grace date after its governing subscription reached
 * `status`. A subscription only ever moves a store between Free and ITS OWN
 * plan: a store placed on another plan (a Scale contract, an admin grant) is
 * never moved by a leftover subscription ending or failing.
 */
export function nextPlan(input: {
  status: string; paidPlanId: string; currentPlanId: string; currentGrace: string | null; now: number; graceDays: number;
}): { planId: string; grace: string | null } {
  const { status, paidPlanId, currentPlanId, currentGrace, now, graceDays } = input;
  const keep = { planId: currentPlanId, grace: currentGrace };
  const ours = currentPlanId === paidPlanId || currentPlanId === 'free';
  if (status === 'active' || status === 'trialing') return ours ? { planId: paidPlanId, grace: null } : keep;
  if (status === 'past_due' || status === 'unpaid') {
    if (currentPlanId !== paidPlanId) return keep; // never grant a plan on a failing payment
    return { planId: paidPlanId, grace: currentGrace || new Date(now + graceDays * 86_400_000).toISOString() };
  }
  if (status === 'canceled' || status === 'incomplete_expired' || status === 'paused') {
    return currentPlanId === paidPlanId ? { planId: 'free', grace: null } : keep;
  }
  return keep; // 'incomplete': the first payment has not gone through yet
}

/** The subscription an event is about (subscription events, or an invoice's). */
export function subscriptionIdOf(event: any): string | null {
  const o = event?.data?.object || {};
  if (String(event?.type || '').startsWith('customer.subscription.')) return o.id || null;
  const s = o.subscription || o.parent?.subscription_details?.subscription || o.lines?.data?.[0]?.parent?.subscription_item_details?.subscription;
  return s ? String(typeof s === 'string' ? s : s.id) : null;
}

export const PLAN_EVENTS = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
]);
