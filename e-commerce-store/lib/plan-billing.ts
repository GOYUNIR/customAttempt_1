/**
 * PLAN BILLING (PRICING.md §9, migration 00038): a store pays for a plan
 * (Growth) through a Stripe Billing subscription on the PLATFORM account, and
 * its plan follows that subscription. The fee engine already charges 0% on a
 * flat-fee plan (lib/billing.ts tenantPlan), so the moment plan_id becomes
 * 'growth' the per-sale fee stops; nothing here touches a sale.
 *
 * Owner decisions (2026-09-27): no trial; a failed renewal keeps the paid plan
 * for a 7-day grace period, then Free; Scale is never self-serve; Stripe Tax
 * is off until activated (PLAN_BILLING_AUTOMATIC_TAX) — a pre-real-revenue
 * requirement, not built here.
 *
 * THE GUARD. The subscription is always re-read from Stripe (never the event
 * payload), and a subscription only moves a store's plan if its Stripe
 * customer is THAT store's customer (tenant_subscriptions), so a subscription
 * carrying another store's id in its metadata changes nothing.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { resolveStripeClient } from '@/services/payment/factory';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { loadPlans } from '@/lib/billing';
import { graduatedFeeWords } from '@/lib/platform-marketing';
import { governing, nextPlan } from '@/lib/plan-billing-rules';

export { PLAN_EVENTS, subscriptionIdOf } from '@/lib/plan-billing-rules';

/** Days a paid plan survives a failed renewal (owner decision; env-overridable). */
export const PLAN_GRACE_DAYS = Math.max(0, Number(process.env.PLAN_GRACE_DAYS) || 7);

type PlanRow = { id: string; name: string; base_price_cents: number; fee_mode: string; listed: boolean; active: boolean };
export type PlanState = {
  planId: string; planName: string; status: string | null; currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean; graceUntil: string | null; hasBillingAccount: boolean; feeLine: string;
  upgrade: { planId: string; name: string; monthlyCents: number } | null;
};

async function plan(id: string): Promise<PlanRow | null> {
  return (((await getDb().select<any>('plans', { where: { id: eq(id) }, select: ['id', 'name', 'base_price_cents', 'fee_mode', 'listed', 'active'], limit: 1 })) as any[])[0]) || null;
}

/** A plan a store may buy by itself: priced, listed, active, flat fee (so Growth, never Scale). */
export async function selfServePlan(): Promise<PlanRow | null> {
  const rows = (await getDb().select<any>('plans', { where: { active: eq(true), listed: eq(true), fee_mode: eq('flat') }, select: ['id', 'name', 'base_price_cents', 'fee_mode', 'listed', 'active'] })) as PlanRow[];
  return rows.filter((p) => Number(p.base_price_cents) > 0).sort((a, b) => a.base_price_cents - b.base_price_cents)[0] || null;
}

/** The Stripe price for a plan, found by lookup key or created from the plans row (amount and name from data). */
async function stripePriceFor(stripe: any, p: PlanRow): Promise<string> {
  const lookupKey = 'plan_' + p.id + '_' + p.base_price_cents + '_monthly';
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (found.data[0]) return found.data[0].id;
  const price = await stripe.prices.create({
    currency: 'usd',
    unit_amount: p.base_price_cents,
    recurring: { interval: 'month' },
    lookup_key: lookupKey,
    product_data: { name: p.name + ' plan', metadata: { plan_id: p.id } },
    metadata: { plan_id: p.id },
  }, { idempotencyKey: 'plan-price:' + lookupKey });
  return price.id;
}

/** This store as a customer of the platform's Stripe account (created once, remembered). */
async function billingCustomer(stripe: any, tenantId: string, email: string): Promise<string> {
  const row = ((await getDb().select<any>('tenant_subscriptions', { where: { tenant_id: eq(tenantId) }, select: ['stripe_customer_id'], limit: 1 })) as any[])[0];
  if (row?.stripe_customer_id) return String(row.stripe_customer_id);
  const customer = await stripe.customers.create({ email, metadata: { tenant_id: tenantId } }, { idempotencyKey: 'plan-customer:' + tenantId });
  await getDb().insert('tenant_subscriptions', { tenant_id: tenantId, stripe_customer_id: customer.id }, { onConflict: 'tenant_id', returning: 'minimal' } as any);
  return customer.id;
}

const appUrl = (path: string) => {
  const root = String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().replace(/\.$/, '');
  return (root ? 'https://app.' + root : '') + path;
};

/** The store's plan as its owner should see it. */
export async function planState(tenantId: string): Promise<PlanState> {
  const db = getDb();
  const [t, s, up] = await Promise.all([
    db.select<any>('tenants', { where: { id: eq(tenantId) }, select: ['plan_id', 'plan_grace_until'], limit: 1 }),
    db.select<any>('tenant_subscriptions', { where: { tenant_id: eq(tenantId) }, select: ['status', 'current_period_end', 'cancel_at_period_end'], limit: 1 }),
    selfServePlan(),
  ]);
  const tenant = (t as any[])[0] || {};
  const sub = (s as any[])[0] || null;
  const graceOver = tenant.plan_grace_until && Date.parse(tenant.plan_grace_until) <= Date.now();
  const planId = graceOver ? 'free' : String(tenant.plan_id || 'free');
  const [p, all] = await Promise.all([plan(planId), loadPlans()]);
  return {
    feeLine: feeLineOf(p, all),
    planId, planName: p?.name || planId, status: sub?.status || null,
    currentPeriodEnd: sub?.current_period_end || null, cancelAtPeriodEnd: sub?.cancel_at_period_end === true,
    graceUntil: tenant.plan_grace_until || null, hasBillingAccount: Boolean(sub),
    // A contract store (custom fees) is never offered a self-serve plan.
    upgrade: up && up.id !== planId && p?.fee_mode !== 'custom' ? { planId: up.id, name: up.name, monthlyCents: up.base_price_cents } : null,
  };
}

/** The per-sale fee of a plan in words, from the plans rows (never hardcoded). */
function feeLineOf(p: PlanRow | null, all: Awaited<ReturnType<typeof loadPlans>>): string {
  if (!p || p.fee_mode === 'custom') return 'Fees as agreed in your contract.';
  if (p.fee_mode === 'flat') {
    const bps = all.find((x) => x.id === p.id)?.platformFeeBps ?? 0;
    return bps === 0 ? 'No per-sale fee.' : 'Per-sale fee: ' + (bps / 100) + '% of each sale.';
  }
  const envelope = all.filter((x) => x.inFeeEnvelope && x.platformFeeBps !== null)
    .map((x) => ({ id: x.id, name: x.name, monthlyCents: x.baseCents, feeBps: x.platformFeeBps as number }));
  const w = graduatedFeeWords(envelope);
  return 'Per-sale fee: ' + w.bands + w.cap + '.';
}

/** A Stripe Checkout (subscription) for the self-serve plan. No trial (owner decision). */
export async function startPlanCheckout(input: { tenantId: string; ownerEmail: string }): Promise<{ ok: true; url: string } | { ok: false; status: number; error: string }> {
  const stripe: any = await resolveStripeClient();
  if (!stripe) return { ok: false, status: 503, error: 'Billing is not available right now.' };
  const target = await selfServePlan();
  if (!target) return { ok: false, status: 409, error: 'There is no plan to switch to.' };
  const state = await planState(input.tenantId);
  if (!state.upgrade) {
    return { ok: false, status: 409, error: state.planId === target.id ? 'This store is already on ' + target.name + '.' : "This store's plan is set by contract. Contact us to change it." };
  }
  const price = await stripePriceFor(stripe, target);
  const customer = await billingCustomer(stripe, input.tenantId, input.ownerEmail);
  const window = Math.floor(Date.now() / 30_000);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: input.tenantId,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { tenant_id: input.tenantId, plan_id: target.id } },
    metadata: { tenant_id: input.tenantId, plan_id: target.id, purpose: 'plan_billing' },
    success_url: appUrl('/app?billing=success'),
    cancel_url: appUrl('/app?billing=cancel'),
    ...(process.env.PLAN_BILLING_AUTOMATIC_TAX === 'true' ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto' } } : {}),
  }, { idempotencyKey: 'plan-checkout:' + input.tenantId + ':' + target.id + ':' + window });
  return { ok: true, url: String(session.url) };
}

/** Stripe's customer portal (cancel, card, invoices) for this store's billing account. */
export async function planPortal(tenantId: string): Promise<{ ok: true; url: string } | { ok: false; status: number; error: string }> {
  const stripe: any = await resolveStripeClient();
  if (!stripe) return { ok: false, status: 503, error: 'Billing is not available right now.' };
  const row = ((await getDb().select<any>('tenant_subscriptions', { where: { tenant_id: eq(tenantId) }, select: ['stripe_customer_id'], limit: 1 })) as any[])[0];
  if (!row?.stripe_customer_id) return { ok: false, status: 404, error: 'This store has no billing account yet.' };
  const configuration = await portalConfiguration(stripe);
  const session = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: appUrl('/app'), configuration });
  return { ok: true, url: String(session.url) };
}

/** Our portal settings (created once through the API, found by metadata after). */
async function portalConfiguration(stripe: any): Promise<string> {
  const list = await stripe.billingPortal.configurations.list({ active: true, limit: 20 });
  const ours = list.data.find((c: any) => c.metadata?.app === 'plan_billing');
  if (ours) return ours.id;
  const created = await stripe.billingPortal.configurations.create({
    metadata: { app: 'plan_billing' },
    features: {
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
  });
  return created.id;
}

/**
 * Bring a store's plan in line with its subscription, RE-READ FROM STRIPE.
 * Idempotent: the same subscription state always yields the same plan.
 */
export async function syncPlanSubscription(subscriptionId: string): Promise<{ applied: boolean; note: string }> {
  const stripe: any = await resolveStripeClient();
  if (!stripe) throw new Error('Stripe is not configured');
  const evented = await stripe.subscriptions.retrieve(subscriptionId);
  const tenantId = String(evented?.metadata?.tenant_id || '');
  const customer = typeof evented.customer === 'string' ? evented.customer : evented.customer?.id;
  if (!tenantId) return { applied: false, note: 'not a plan subscription' };
  const db = getDb();
  const row = ((await db.select<any>('tenant_subscriptions', { where: { tenant_id: eq(tenantId) }, select: ['stripe_customer_id'], limit: 1 })) as any[])[0];
  if (!row || row.stripe_customer_id !== customer) {
    // THE GUARD: metadata names a store, but this is not that store's customer.
    console.error('[plan-billing] REFUSED subscription ' + subscriptionId + ': customer ' + customer + ' is not the billing customer of store ' + tenantId);
    return { applied: false, note: 'refused: customer does not belong to the store in metadata' };
  }
  // The plan follows the store's GOVERNING subscription, not whichever one
  // this event is about: an owner who paid twice (two Checkout tabs) and then
  // cancels one must stay on the plan the other still pays for.
  const sub = governing(await listCustomerSubscriptions(stripe, customer), evented);
  subscriptionId = String(sub.id);
  const paidPlanId = String(sub?.metadata?.plan_id || '');
  const paid = paidPlanId ? await plan(paidPlanId) : null;
  if (!paid || paid.fee_mode === 'custom' || Number(paid.base_price_cents) <= 0) return { applied: false, note: 'unknown or non-self-serve plan ' + paidPlanId };

  const item = sub.items?.data?.[0];
  const periodEnd = Number(sub.current_period_end || item?.current_period_end || 0);
  const status = String(sub.status);
  const tenant = ((await db.select<any>('tenants', { where: { id: eq(tenantId) }, select: ['plan_id', 'plan_grace_until'], limit: 1 })) as any[])[0] || {};
  const { planId, grace } = nextPlan({
    status, paidPlanId: paid.id, currentPlanId: String(tenant.plan_id || 'free'),
    currentGrace: tenant.plan_grace_until || null, now: Date.now(), graceDays: PLAN_GRACE_DAYS,
  });

  await db.update('tenant_subscriptions', { where: { tenant_id: eq(tenantId) } }, {
    stripe_subscription_id: subscriptionId, plan_id: paid.id, status,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancel_at_period_end: sub.cancel_at_period_end === true, updated_at: new Date().toISOString(),
  }, { returning: 'minimal' } as any);
  const changed = planId !== String(tenant.plan_id || 'free') || (grace || null) !== (tenant.plan_grace_until || null);
  if (changed) {
    await db.update('tenants', { where: { id: eq(tenantId) } }, { plan_id: planId, plan_grace_until: grace }, { returning: 'minimal' } as any);
    await recordPlatformAudit({ action: 'PLAN_CHANGED', actor: 'stripe', tenantId, detail: { from: tenant.plan_id, to: planId, status, grace_until: grace, subscription: subscriptionId } });
  }
  return { applied: true, note: 'store ' + tenantId + ': ' + status + ' -> plan ' + planId + (grace ? ' (grace until ' + grace + ')' : '') };
}

async function listCustomerSubscriptions(stripe: any, customer: string): Promise<any[]> {
  const list = await stripe.subscriptions.list({ customer, status: 'all', limit: 20 });
  return list.data || [];
}
