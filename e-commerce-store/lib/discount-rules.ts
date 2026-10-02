/**
 * DISCOUNT RULES (DISCOUNT-CODES.md, decisions approved 2026-10-01) — pure,
 * no imports; tests/discount-rules.test.ts.
 *
 *   - whole-order codes, one per order; percent (1–90%) or a fixed amount;
 *   - the discount is applied by REDUCING the prices we send Stripe, so the
 *     charge, our fee (computed on what is charged) and the order all agree;
 *   - NEVER below Stripe's minimum charge: the discount is capped so the
 *     total stays at or above it (owner's requirement);
 *   - a fixed amount is spread over the lines in proportion to their value,
 *     and per UNIT (Stripe charges unit price x quantity), so the applied
 *     discount can be a few cents under the nominal one, never over.
 */

/** Stripe's minimum charge per currency, in its smallest unit (Stripe docs,
 *  "Minimum and maximum charge amounts"). 50 is the safe default. */
const MIN_CHARGE: Record<string, number> = {
  usd: 50, aud: 50, brl: 50, cad: 50, chf: 50, eur: 50, inr: 50, nzd: 50, sgd: 50,
  gbp: 30, dkk: 250, hkd: 400, jpy: 50, mxn: 1000, nok: 300, pln: 200, sek: 300, czk: 1500, huf: 17500, ron: 200, bgn: 100, aed: 200, myr: 200, thb: 1000,
};
export function minChargeCents(currency: string): number {
  return MIN_CHARGE[String(currency || '').toLowerCase()] ?? 50;
}

export const CODE_RE = /^[A-Z0-9-]{4,24}$/;
export function normalizeCode(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export type DiscountInput = {
  code: string; kind: 'percent' | 'fixed'; percentBps: number | null; amountCents: number | null;
  minSubtotalCents: number; startsAt: string | null; endsAt: string | null; maxUses: number | null; maxUsesPerCustomer: number;
};

/** What a merchant may create (Code, Type, Amount; the rest optional). */
export function validateDiscountInput(raw: any): { ok: true; value: DiscountInput } | { ok: false; error: string } {
  const code = normalizeCode(raw?.code);
  if (!CODE_RE.test(code)) return { ok: false, error: 'The code is 4 to 24 letters, numbers or dashes.' };
  const kind = raw?.kind === 'fixed' ? 'fixed' : raw?.kind === 'percent' ? 'percent' : null;
  if (!kind) return { ok: false, error: 'Choose percent off or an amount off.' };
  const amount = Number(raw?.amount);
  let percentBps: number | null = null, amountCents: number | null = null;
  if (kind === 'percent') {
    if (!Number.isFinite(amount) || amount < 1 || amount > 90 || Math.round(amount * 100) !== amount * 100) return { ok: false, error: 'Percent off is from 1 to 90.' };
    percentBps = Math.round(amount * 100);
  } else {
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000 || Math.round(amount * 100) / 100 !== amount) return { ok: false, error: 'The amount off is more than 0, in cents at most.' };
    amountCents = Math.round(amount * 100);
  }
  const min = raw?.minSubtotal === undefined || raw?.minSubtotal === '' || raw?.minSubtotal === null ? 0 : Number(raw.minSubtotal);
  if (!Number.isFinite(min) || min < 0 || min > 100000) return { ok: false, error: 'The minimum order is a positive amount.' };
  const date = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number.isNaN(Date.parse(String(v))) ? 'bad' : new Date(String(v)).toISOString());
  const startsAt = date(raw?.startsAt), endsAt = date(raw?.endsAt);
  if (startsAt === 'bad' || endsAt === 'bad') return { ok: false, error: 'A date is not valid.' };
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) return { ok: false, error: 'The end date must be after the start.' };
  const int = (v: unknown, d: number | null) => (v === undefined || v === null || v === '' ? d : Number(v));
  const maxUses = int(raw?.maxUses, null);
  const perCustomer = int(raw?.maxUsesPerCustomer, 1);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000)) return { ok: false, error: 'Total uses is a whole number of at least 1.' };
  if (!Number.isInteger(perCustomer) || (perCustomer as number) < 1 || (perCustomer as number) > 1000) return { ok: false, error: 'Uses per customer is a whole number of at least 1.' };
  return { ok: true, value: { code, kind, percentBps, amountCents, minSubtotalCents: Math.round(min * 100), startsAt, endsAt, maxUses, maxUsesPerCustomer: perCustomer as number } };
}

export type CheckoutLine = { unitCents: number; quantity: number };

/**
 * Apply a reserved code to the lines. Returns the new unit prices and the
 * discount actually applied (what the order records and Stripe charges less).
 */
export function applyDiscount(
  code: { kind: 'percent' | 'fixed'; percentBps?: number | null; amountCents?: number | null },
  lines: CheckoutLine[],
  currency: string,
): { lines: CheckoutLine[]; discountCents: number; subtotalCents: number; capped: boolean } {
  const subtotal = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  const nominal = code.kind === 'percent'
    ? Math.round((subtotal * Math.min(9000, Math.max(0, Number(code.percentBps) || 0))) / 10000)
    : Math.max(0, Math.round(Number(code.amountCents) || 0));
  const room = Math.max(0, subtotal - minChargeCents(currency));
  const target = Math.min(nominal, room);
  if (target <= 0 || subtotal <= 0) return { lines: lines.map((l) => ({ ...l })), discountCents: 0, subtotalCents: subtotal, capped: nominal > 0 };
  // Proportional per-line shares (largest remainder), then per unit.
  const shares = lines.map((l) => (target * l.unitCents * l.quantity) / subtotal);
  const floors = shares.map(Math.floor);
  let left = target - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => [s - floors[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; floors[i]++; left--; }
  const out = lines.map((l, i) => {
    const perUnit = Math.min(l.unitCents, Math.floor(floors[i] / l.quantity));
    return { unitCents: l.unitCents - perUnit, quantity: l.quantity };
  });
  const applied = subtotal - out.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  return { lines: out, discountCents: applied, subtotalCents: subtotal, capped: target < nominal };
}
