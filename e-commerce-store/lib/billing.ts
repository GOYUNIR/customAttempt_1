/**
 * BILLING — the platform's side of every sale: which plan a tenant is on, what
 * the graduated fee is, and the running monthly total it is computed from.
 *
 * Backed by 00032 (public.plans fee terms, tenants.plan_id,
 * public.tenant_billing_charges and three SQL functions). Design: PRICING.md.
 *
 * THE MONEY-PATH RULES THIS MODULE KEEPS (PRICING.md §6)
 *   - The month's total is advanced by record_billing_charge(), which inserts
 *     one row per PaymentIntent. The primary key decides; nothing here reads a
 *     total, adds to it and writes it back. A redelivered webhook records
 *     nothing twice.
 *   - Refunds are applied as Stripe's cumulative totals (set, not add), so a
 *     redelivered refund event changes nothing (D5).
 *   - The month is the calendar month in UTC (D4), always derived here.
 *   - Fee inputs come from public.plans rows marked in_fee_envelope — never
 *     from every plan, because Scale is stored at $0 and would zero the fee.
 *
 * Nothing in here charges anyone. Collection is Stripe Connect's application
 * fee; this is what Connect will call.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { feeForChargeCents, type FeePlan } from '@/lib/pricing/graduated-fee';

/** D4: the billing month is the calendar month in UTC, as its first day. */
export function billingMonthOf(at: Date = new Date()): string {
  return at.getUTCFullYear() + '-' + String(at.getUTCMonth() + 1).padStart(2, '0') + '-01';
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { serviceRoleKey } = readSupabaseEnv();
  // POSTs are never retried by supabaseRestFetch. The two writing functions
  // are idempotent, so a caller that times out may safely call again.
  return (await supabaseRestFetch('/rpc/' + fn, {
    key: serviceRoleKey, method: 'POST', body: args, prefer: 'return=representation',
  })) as T;
}

export type PlanTerms = {
  id: string;
  name: string;
  baseCents: number;
  platformFeeBps: number | null;
  feeMode: 'graduated' | 'flat' | 'custom';
  inFeeEnvelope: boolean;
  listed: boolean;
};

function toTerms(r: any): PlanTerms {
  return {
    id: String(r.id),
    name: String(r.name),
    baseCents: Number(r.base_price_cents) || 0,
    platformFeeBps: r.platform_fee_bps === null || r.platform_fee_bps === undefined ? null : Number(r.platform_fee_bps),
    feeMode: r.fee_mode,
    inFeeEnvelope: Boolean(r.in_fee_envelope),
    listed: Boolean(r.listed),
  };
}

const PLAN_COLUMNS = ['id', 'name', 'base_price_cents', 'platform_fee_bps', 'fee_mode', 'in_fee_envelope', 'listed', 'sort_order', 'active'];

/** Every active plan, in display order. */
export async function loadPlans(): Promise<PlanTerms[]> {
  const rows = (await getDb().select<any>('plans', { where: { active: eq(true) }, select: PLAN_COLUMNS, limit: 50 })) as any[];
  return rows.sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).map(toTerms);
}

/** The cost lines the graduated fee is the minimum of (in_fee_envelope only). */
export function envelopeOf(plans: PlanTerms[]): FeePlan[] {
  return plans
    .filter((p) => p.inFeeEnvelope && p.platformFeeBps !== null)
    .map((p) => ({ id: p.id, monthlyCents: p.baseCents, feeBps: p.platformFeeBps as number }));
}

/** The plan a tenant is on. Throws if the tenant or plan cannot be read. */
export async function tenantPlan(tenantId: string): Promise<PlanTerms> {
  const db = getDb();
  const tenant = ((await db.select<any>('tenants', { where: { id: eq(tenantId) }, select: ['plan_id'], limit: 1 })) as any[])[0];
  if (!tenant) throw new Error('[billing] unknown tenant ' + tenantId);
  const plan = ((await db.select<any>('plans', { where: { id: eq(String(tenant.plan_id)) }, select: PLAN_COLUMNS, limit: 1 })) as any[])[0];
  if (!plan) throw new Error('[billing] tenant ' + tenantId + ' is on unknown plan ' + tenant.plan_id);
  return toTerms(plan);
}

/** The month's net sales volume so far, in cents. */
export async function billingMonthVolume(tenantId: string, month: string = billingMonthOf()): Promise<number> {
  const v = await rpc<number | string>('billing_month_volume', { p_tenant: tenantId, p_month: month });
  return Number(v) || 0;
}

/**
 * Record one successful charge. `recorded` is false when this PaymentIntent
 * was already recorded (a webhook redelivery) — not an error.
 */
export async function recordBillingCharge(input: {
  paymentIntentId: string;
  tenantId: string;
  volumeCents: number;
  feeCents: number;
  orderId?: string | null;
  month?: string;
}): Promise<{ recorded: boolean; monthVolumeCents: number }> {
  if (!input.paymentIntentId) throw new Error('[billing] a charge needs its PaymentIntent id');
  const rows = await rpc<Array<{ recorded: boolean; month_volume: number | string }>>('record_billing_charge', {
    p_payment_intent: input.paymentIntentId,
    p_tenant: input.tenantId,
    p_month: input.month || billingMonthOf(),
    p_volume_cents: Math.max(0, Math.round(input.volumeCents)),
    p_fee_cents: Math.max(0, Math.round(input.feeCents)),
    p_order: input.orderId ?? null,
  });
  const row = Array.isArray(rows) ? rows[0] : (rows as any);
  return { recorded: Boolean(row?.recorded), monthVolumeCents: Number(row?.month_volume) || 0 };
}

/**
 * Apply a refund as Stripe's CUMULATIVE totals for the charge (D5). Returns
 * false when the charge was never recorded — a reconciliation item the caller
 * must log loudly, never drop.
 */
export async function setBillingRefund(paymentIntentId: string, refundedVolumeCents: number, refundedFeeCents: number): Promise<boolean> {
  const ok = await rpc<boolean>('set_billing_refund', {
    p_payment_intent: paymentIntentId,
    p_refunded_volume_cents: Math.max(0, Math.round(refundedVolumeCents)),
    p_refunded_fee_cents: Math.max(0, Math.round(refundedFeeCents)),
  });
  return ok === true;
}

/**
 * The platform fee for a charge about to be created, for Connect's
 * application_fee_amount (PRICING.md §6):
 *   graduated — the increase in the month's envelope this charge causes,
 *               from the month's volume as it stands now;
 *   flat      — the plan's rate on the amount;
 *   custom    — 0 here; a contract, billed outside this path.
 *
 * FAIL TOWARDS THE MERCHANT: if the running total cannot be read, the fee is
 * 0 and the caller logs it for reconciliation. Blocking the sale would cost
 * the merchant real money; guessing could overcharge them.
 */
export async function platformFeeForCharge(tenantId: string, amountCents: number): Promise<{
  feeCents: number; planId: string; basis: 'graduated' | 'flat' | 'custom' | 'unavailable'; monthVolumeCents: number | null;
}> {
  const amount = Math.max(0, Math.round(amountCents));
  let plan: PlanTerms;
  try {
    plan = await tenantPlan(tenantId);
  } catch (err) {
    console.error('[billing] plan unreadable for ' + tenantId + ' — charging no platform fee (reconcile)', (err as Error)?.message || err);
    return { feeCents: 0, planId: 'unknown', basis: 'unavailable', monthVolumeCents: null };
  }
  if (plan.feeMode === 'custom') return { feeCents: 0, planId: plan.id, basis: 'custom', monthVolumeCents: null };
  if (plan.feeMode === 'flat') {
    const bps = plan.platformFeeBps ?? 0;
    // Round half up, in integers.
    return { feeCents: Math.floor((amount * bps + 5000) / 10000), planId: plan.id, basis: 'flat', monthVolumeCents: null };
  }
  try {
    const [plans, volume] = await Promise.all([loadPlans(), billingMonthVolume(tenantId)]);
    return {
      feeCents: feeForChargeCents(envelopeOf(plans), volume, amount),
      planId: plan.id,
      basis: 'graduated',
      monthVolumeCents: volume,
    };
  } catch (err) {
    console.error('[billing] running total unreadable for ' + tenantId + ' — charging no platform fee (reconcile)', (err as Error)?.message || err);
    return { feeCents: 0, planId: plan.id, basis: 'unavailable', monthVolumeCents: null };
  }
}
