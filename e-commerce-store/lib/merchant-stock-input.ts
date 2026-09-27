/**
 * Input rules for the merchant stock tools (/api/merchant/stock/*). Pure, so
 * tests/merchant-routes.test.ts can pin them. The store is never an input:
 * it comes from the session, and the database refuses another store's size
 * (supabase/migrations/00037) whatever id is sent.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_STOCK = 1_000_000;
const REASONS = ['restock', 'adjust', 'correction'] as const;
export type AdjustReason = (typeof REASONS)[number];

type Ok<T> = { ok: true; value: T };
type Bad = { ok: false; error: string };

function note(raw: unknown): string | undefined {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return n || undefined;
}
function variant(raw: unknown): string | null {
  const v = String(raw ?? '').trim();
  return UUID.test(v) ? v.toLowerCase() : null;
}

export function validateStockSet(body: any): Ok<{ variantId: string; count: number; note?: string }> | Bad {
  const variantId = variant(body?.variantId);
  if (!variantId) return { ok: false, error: 'Unknown size.' };
  // An absent or blank count is NOT zero: Number(null) and Number('') are 0,
  // and a blank field silently zeroing stock would pull the size from sale.
  const raw = body?.count;
  const count = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(count) || count < 0 || count > MAX_STOCK) return { ok: false, error: 'Enter a whole number of units, 0 or more.' };
  return { ok: true, value: { variantId, count, note: note(body?.note) } };
}

export function validateStockAdjust(body: any): Ok<{ variantId: string; delta: number; reason: AdjustReason; note?: string }> | Bad {
  const variantId = variant(body?.variantId);
  if (!variantId) return { ok: false, error: 'Unknown size.' };
  const delta = Number(body?.delta);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_STOCK) return { ok: false, error: 'Enter how many units to add or remove (not 0).' };
  const reason = String(body?.reason || (delta > 0 ? 'restock' : 'adjust')) as AdjustReason;
  if (!REASONS.includes(reason)) return { ok: false, error: 'Pick a reason.' };
  return { ok: true, value: { variantId, delta, reason, note: note(body?.note) } };
}

export function validateVariantParam(raw: unknown): string | null {
  return variant(raw);
}
