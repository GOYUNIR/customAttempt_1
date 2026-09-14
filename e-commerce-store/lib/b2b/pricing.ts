/**
 * ─────────────────────────────────────────────────────────────────────────────
 * B2B PRICING — tiered volume discounts + contract price-list resolution.
 *
 * Pure decision logic (mirrors lib/rbac.ts / lib/lockdown.ts: zero imports,
 * edge-safe, `node --test`-loadable) over the shapes stored in
 * `public.price_lists` / `public.price_list_entries`
 * (supabase/migrations/00009_commerce_b2b_core.sql). The persistence layer
 * (which price list applies to which company, fetching entries) is a
 * separate, ordinary Supabase-REST call site — this module only decides
 * WHICH price wins once you have the candidate entries in hand, so it can be
 * unit-tested without a database.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface PriceListEntry {
  variantId: string;
  unitPriceCents: number;
  /** At/above this quantity, `unitPriceCents` applies — multiple entries per
   *  variant (increasing `minQuantity`) form the volume discount matrix. */
  minQuantity: number;
}

/**
 * Resolve the effective unit price for `variantId` at `quantity`:
 *   1. Among this variant's price-list entries whose `minQuantity <= quantity`,
 *      pick the one with the HIGHEST `minQuantity` (the best-qualifying tier).
 *   2. Falls back to `basePriceCents` (the catalog/list price) when no entry
 *      qualifies — including when the price list has no entries for this
 *      variant at all, or `quantity` is below every tier's minimum.
 *
 * Never throws; malformed entries (negative/non-finite price or quantity)
 * are ignored rather than crashing a checkout price calculation.
 */
export function resolveUnitPriceCents(
  entries: PriceListEntry[],
  variantId: string,
  quantity: number,
  basePriceCents: number,
): number {
  const qty = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 0;
  const candidates = (Array.isArray(entries) ? entries : []).filter(
    (e) =>
      e &&
      e.variantId === variantId &&
      Number.isFinite(e.unitPriceCents) &&
      e.unitPriceCents >= 0 &&
      Number.isFinite(e.minQuantity) &&
      e.minQuantity >= 1 &&
      e.minQuantity <= qty,
  );
  if (candidates.length === 0) return Math.max(0, Math.round(basePriceCents) || 0);
  const best = candidates.reduce((a, b) => (b.minQuantity > a.minQuantity ? b : a));
  return Math.round(best.unitPriceCents);
}

/** The full volume-discount tier ladder for one variant, sorted ascending by
 *  `minQuantity` — used to render "buy 10+ for $X, 50+ for $Y" UI copy. */
export function tiersForVariant(entries: PriceListEntry[], variantId: string): PriceListEntry[] {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.variantId === variantId && Number.isFinite(e.minQuantity) && e.minQuantity >= 1)
    .sort((a, b) => a.minQuantity - b.minQuantity);
}

export interface QuoteLineInput {
  variantId: string;
  quantity: number;
  /** The catalog price at the time the quote line was created — kept
   *  separate from the negotiated price so a sales rep can see the discount
   *  they're granting (mirrors `quote_line_items.original_price_cents`). */
  originalPriceCents: number;
  /** A sales rep's negotiated override, when set. Null/undefined = still at
   *  the original (or price-list-resolved) price. */
  negotiatedPriceCents?: number | null;
}

/** The effective unit price for a quote line: negotiated price wins when
 *  set, else the original/catalog price. Never negative. */
export function effectiveQuoteLinePriceCents(line: QuoteLineInput): number {
  const negotiated = line.negotiatedPriceCents;
  if (typeof negotiated === 'number' && Number.isFinite(negotiated) && negotiated >= 0) {
    return Math.round(negotiated);
  }
  return Math.max(0, Math.round(line.originalPriceCents) || 0);
}

/** Sum a quote's line items into a subtotal, in cents. */
export function quoteSubtotalCents(lines: QuoteLineInput[]): number {
  return (Array.isArray(lines) ? lines : []).reduce((sum, line) => {
    const qty = Number.isFinite(line.quantity) && line.quantity > 0 ? Math.floor(line.quantity) : 0;
    return sum + effectiveQuoteLinePriceCents(line) * qty;
  }, 0);
}
