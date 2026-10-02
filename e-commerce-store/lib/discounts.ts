/**
 * DISCOUNT CODES (server side; rules in lib/discount-rules.ts, data in 00045).
 *
 * Every call takes the store from its caller (the merchant session, or the
 * storefront's Host), never from input. Behind the plan flag
 * `plans.discount_codes_enabled`, OFF on every plan until switched on.
 */
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { tenantPlan } from '@/lib/billing';
import { readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { applyDiscount, normalizeCode, CODE_RE, type CheckoutLine, type DiscountInput } from '@/lib/discount-rules';

const rpc = async (fn: string, body: Record<string, unknown>) =>
  supabaseRestFetch('/rpc/' + fn, { key: readSupabaseEnv().serviceRoleKey, method: 'POST', body });

/** Is the store's plan allowed discount codes (and how many active)? */
export async function discountAccess(tenantId: string): Promise<{ enabled: boolean; limit: number | null }> {
  try {
    const plan = await tenantPlan(tenantId);
    return { enabled: plan.discountCodesEnabled, limit: plan.discountCodeLimit };
  } catch {
    return { enabled: false, limit: 0 }; // unreadable plan: no discounts (fail closed)
  }
}

export type CheckoutDiscount =
  | { ok: true; applied: false }
  | { ok: true; applied: true; code: string; discountCents: number; lines: CheckoutLine[]; capped: boolean }
  | { ok: false; status: number; error: string };

/** The ONE answer for a code that cannot be used, whatever the reason. */
export const INVALID_CODE = "That code isn't valid.";

/**
 * Reserve and apply a code for one checkout attempt (holdKey = the attempt's
 * stock-hold key, so a double tap reuses the same reservation). No code: no-op.
 */
export async function discountForCheckout(input: {
  tenantId: string; code: unknown; email: string; holdKey: string; lines: CheckoutLine[]; currency: string; ttlSeconds: number;
}): Promise<CheckoutDiscount> {
  const code = normalizeCode(input.code);
  if (!code) return { ok: true, applied: false };
  const access = await discountAccess(input.tenantId);
  if (!access.enabled) return { ok: false, status: 409, error: "Promo codes aren't available in this store yet. Remove it to continue." };
  if (!CODE_RE.test(code)) return { ok: false, status: 400, error: INVALID_CODE };
  const subtotal = input.lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const r: any = await rpc('reserve_discount', {
    p_tenant: input.tenantId, p_code: code, p_email: input.email, p_hold_key: input.holdKey,
    p_subtotal_cents: subtotal, p_currency: input.currency, p_ttl_seconds: Math.max(60, Math.round(input.ttlSeconds)),
  });
  if (r?.result === 'minimum') {
    const min = (Number(r.min_subtotal_cents) / 100).toFixed(2);
    return { ok: false, status: 400, error: 'That code needs an order of at least ' + min + ' ' + input.currency.toUpperCase() + '.' };
  }
  if (r?.result !== 'ok') {
    if (r?.why) console.warn('[discounts] ' + input.tenantId + ' code refused: ' + r.why);
    return { ok: false, status: 400, error: INVALID_CODE };
  }
  const out = applyDiscount({ kind: r.kind, percentBps: r.percent_bps, amountCents: r.amount_cents }, input.lines, input.currency);
  return { ok: true, applied: true, code: String(r.code), discountCents: out.discountCents, lines: out.lines, capped: out.capped };
}

/**
 * READ-ONLY check for the storefront's "Apply" button: would this code work
 * for this email and subtotal right now? Takes nothing (checkout reserves).
 * One generic answer for every reason a code cannot be used.
 */
export async function previewDiscount(tenantId: string, rawCode: unknown, email: string, subtotalCents: number): Promise<
  { valid: true; percent: number | null; amountCents: number | null } | { valid: false; error: string }
> {
  const access = await discountAccess(tenantId);
  if (!access.enabled) return { valid: false, error: "Promo codes aren't available in this store yet." };
  const code = normalizeCode(rawCode);
  if (!CODE_RE.test(code)) return { valid: false, error: INVALID_CODE };
  const c = ((await getDb().select<any>('discount_codes', { where: { tenant_id: eq(tenantId), code: eq(code) }, limit: 1 })) as any[])[0];
  const now = Date.now();
  if (!c || !c.active || Date.parse(c.starts_at) > now || (c.ends_at && Date.parse(c.ends_at) <= now)) return { valid: false, error: INVALID_CODE };
  if (subtotalCents > 0 && subtotalCents < Number(c.min_subtotal_cents)) return { valid: false, error: 'That code needs an order of at least ' + (Number(c.min_subtotal_cents) / 100).toFixed(2) + '.' };
  const live = (r: any) => r.status === 'redeemed' || (r.status === 'held' && (!r.expires_at || Date.parse(r.expires_at) > now));
  const uses = ((await getDb().select<any>('discount_redemptions', { where: { tenant_id: eq(tenantId), code_id: eq(String(c.id)) }, select: ['status', 'expires_at', 'email'], limit: 100000 })) as any[]).filter(live);
  if (c.max_uses !== null && uses.length >= Number(c.max_uses)) return { valid: false, error: INVALID_CODE };
  if (email && uses.filter((u) => String(u.email).toLowerCase() === email.toLowerCase()).length >= Number(c.max_uses_per_customer)) return { valid: false, error: INVALID_CODE };
  return { valid: true, percent: c.percent_bps === null ? null : c.percent_bps / 100, amountCents: c.amount_cents === null ? null : Number(c.amount_cents) };
}

/** The checkout was paid: the held use becomes a redemption (idempotent). */
export async function redeemDiscount(tenantId: string, holdKey: string, orderRef: string, discountCents: number): Promise<void> {
  await rpc('redeem_discount', { p_tenant: tenantId, p_hold_key: holdKey, p_order_ref: orderRef, p_discount_cents: Math.max(0, Math.round(discountCents)) });
}

/** The checkout expired unpaid (or could not start): give the use back. */
export async function releaseDiscount(tenantId: string, holdKey: string): Promise<void> {
  await rpc('release_discount', { p_tenant: tenantId, p_hold_key: holdKey }).catch(() => null);
}

// ── Merchant management ─────────────────────────────────────────────────────

export async function listCodes(tenantId: string) {
  const codes = (await getDb().select<any>('discount_codes', { where: { tenant_id: eq(tenantId) }, order: { column: 'created_at', ascending: false }, limit: 200 })) as any[];
  const ids = codes.map((c) => String(c.id));
  const uses = ids.length ? ((await getDb().select<any>('discount_redemptions', { where: { tenant_id: eq(tenantId), code_id: inList(ids), status: eq('redeemed') }, select: ['code_id', 'discount_cents'], limit: 10000 })) as any[]) : [];
  return codes.map((c) => {
    const mine = uses.filter((u) => u.code_id === c.id);
    return {
      id: c.id, code: c.code, kind: c.kind, percent: c.percent_bps === null ? null : c.percent_bps / 100,
      amountCents: c.amount_cents === null ? null : Number(c.amount_cents), currency: c.currency,
      minSubtotalCents: Number(c.min_subtotal_cents), startsAt: c.starts_at, endsAt: c.ends_at,
      maxUses: c.max_uses, maxUsesPerCustomer: c.max_uses_per_customer, active: c.active,
      uses: mine.length, discountGivenCents: mine.reduce((s, u) => s + Number(u.discount_cents || 0), 0),
    };
  });
}

export async function createCode(tenantId: string, input: DiscountInput, currency: string, by: string): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
  const access = await discountAccess(tenantId);
  if (!access.enabled) return { ok: false, status: 403, error: 'Discount codes are not on your plan.' };
  if (access.limit !== null) {
    const active = ((await getDb().select<any>('discount_codes', { where: { tenant_id: eq(tenantId), active: eq(true) }, select: ['id'], limit: 1000 })) as any[]).length;
    if (active >= access.limit) return { ok: false, status: 409, error: 'Your plan allows ' + access.limit + ' active codes. Switch one off first.' };
  }
  try {
    const rows = (await getDb().insert<any>('discount_codes', {
      tenant_id: tenantId, code: input.code, kind: input.kind, percent_bps: input.percentBps, amount_cents: input.amountCents,
      currency: input.kind === 'fixed' ? currency.toLowerCase() : null, min_subtotal_cents: input.minSubtotalCents,
      ...(input.startsAt ? { starts_at: input.startsAt } : {}), ends_at: input.endsAt, max_uses: input.maxUses,
      max_uses_per_customer: input.maxUsesPerCustomer, active: true, created_by: by,
    })) as any[];
    return { ok: true, id: String(rows?.[0]?.id) };
  } catch (err) {
    if (/duplicate|23505|unique/i.test(String((err as Error)?.message))) return { ok: false, status: 409, error: 'You already have a code called ' + input.code + '.' };
    throw err;
  }
}

/** Switch one of THIS store's codes on or off. */
export async function setCodeActive(tenantId: string, id: string, active: boolean): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const row = ((await getDb().select<any>('discount_codes', { where: { tenant_id: eq(tenantId), id: eq(id) }, select: ['id'], limit: 1 })) as any[])[0];
  if (!row) return { ok: false, status: 404, error: 'Code not found.' };
  if (active) {
    const access = await discountAccess(tenantId);
    if (!access.enabled) return { ok: false, status: 403, error: 'Discount codes are not on your plan.' };
    if (access.limit !== null) {
      const n = ((await getDb().select<any>('discount_codes', { where: { tenant_id: eq(tenantId), active: eq(true) }, select: ['id'], limit: 1000 })) as any[]).length;
      if (n >= access.limit) return { ok: false, status: 409, error: 'Your plan allows ' + access.limit + ' active codes. Switch one off first.' };
    }
  }
  await getDb().update('discount_codes', { where: { tenant_id: eq(tenantId), id: eq(id) } }, { active }, { returning: 'minimal' } as any);
  return { ok: true };
}
