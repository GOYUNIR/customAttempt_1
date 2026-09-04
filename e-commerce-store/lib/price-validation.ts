/**
 * Price validation — the bulletproof gate for "no sentinel prices, ever".
 *
 * A sellable size MUST carry a real, numeric price of at least $0.01. The
 * historical placeholder sentinel (`UNCONFIGURED_PRICE_SENTINEL = 9999999`,
 * used to mean "not configured yet") and zero/negative values are all REJECTED.
 * Prices are returned as integer cents so float rounding can never leak a
 * $19.9999 price into Stripe or the storefront.
 *
 * This module is dependency-free (no `@/` imports) so `node --test`, the admin
 * client and the API routes share the exact same validation.
 */

/** Minimum sellable price, in cents ($0.01). */
export const MIN_PRICE_CENTS = 1;
/** Upper bound, in dollars — values at/above this are sentinels, not prices. */
export const MAX_PRICE_DOLLARS = 9999999;
/** Upper bound, in cents ($9,999,999.00). */
export const MAX_PRICE_CENTS = MAX_PRICE_DOLLARS * 100;

/** Known non-price sentinel values. `0`, negative numbers and the legacy
 *  `9999999` placeholder are never valid prices. */
export function isSentinelPrice(value: unknown): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) return true;
  if (n <= 0) return true;
  if (n >= MAX_PRICE_DOLLARS) return true;
  return false;
}

/** True when a value is a real, sellable price (>= $0.01 and < sentinel). */
export function isConfiguredPrice(value: unknown): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0.01 && n < MAX_PRICE_DOLLARS;
}

export type PriceValidationResult = {
  ok: boolean;
  /** Integer cents, or null when invalid. */
  cents: number | null;
  /** Human-readable error, or undefined when ok. */
  error?: string;
};

/** Parse a price (number in dollars, or numeric string) into integer cents. */
export function parsePriceCents(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01 || n >= MAX_PRICE_DOLLARS) return null;
  return Math.round(n * 100);
}

/** Validate a single price. Never throws. */
export function validatePrice(value: unknown): PriceValidationResult {
  if (value === '' || value === null || value === undefined) {
    return { ok: false, cents: null, error: 'Price is required.' };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { ok: false, cents: null, error: 'Price must be a number.' };
  }
  if (n >= MAX_PRICE_DOLLARS) {
    return { ok: false, cents: null, error: 'Placeholder prices are not allowed — set a real price.' };
  }
  if (n < 0.01) {
    return { ok: false, cents: null, error: 'Price must be at least $0.01.' };
  }
  return { ok: true, cents: Math.round(n * 100) };
}

/** Validate every price category. Returns a per-size error list. */
export function validatePriceCategories(categories: unknown): {
  ok: boolean;
  errors: Array<{ size: string; error: string }>;
} {
  const errors: Array<{ size: string; error: string }> = [];
  const list = Array.isArray(categories) ? categories : [];
  for (const raw of list) {
    const cat = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const size = String(cat.size ?? '').trim() || 'Unnamed size';
    const res = validatePrice(cat.price);
    if (!res.ok) errors.push({ size, error: res.error as string });
  }
  return { ok: errors.length === 0, errors };
}
