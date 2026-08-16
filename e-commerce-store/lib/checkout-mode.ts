/**
 * Per-size checkout-mode resolution ("a product can be BOTH a raffle and a
 * direct-sale at the same time").
 *
 * Each `priceCategories[]` entry may carry its own `checkoutMode`
 * ('RAFFLE' | 'FCFS'); when a size has no override the product-level
 * `checkoutMode` / `isRaffle` decides. This is the SINGLE resolver used by the
 * storefront, the single-product checkout, the cart checkout and the auto-draw
 * engine so every consumer agrees on what a size actually is.
 *
 * NOTE: this module is intentionally SELF-CONTAINED (no `@/` imports) so the
 * `node --test` runner can import it directly, matching `drop-timestamps.ts`.
 */

/** Resolve the checkout mode for a SPECIFIC size on a product. */
export function getSizeCheckoutMode(product: any, size?: string | null): 'RAFFLE' | 'FCFS' {
  const key = String(size || '').trim().toLowerCase();
  if (key && Array.isArray(product?.priceCategories)) {
    const category = (product.priceCategories as any[]).find(
      (c) => String(c?.size || '').trim().toLowerCase() === key,
    );
    const categoryMode = String(category?.checkoutMode || '').toUpperCase();
    if (categoryMode === 'FCFS') return 'FCFS';
    if (categoryMode === 'RAFFLE') return 'RAFFLE';
  }
  const productMode = String(product?.checkoutMode || '').toUpperCase();
  if (productMode === 'FCFS') return 'FCFS';
  if (productMode === 'RAFFLE') return 'RAFFLE';
  if (product?.isRaffle === false || String(product?.productType || '').toLowerCase() === 'fcfs') return 'FCFS';
  return 'RAFFLE';
}

/** Whether the product mixes raffle AND direct-sale sizes under one roof. */
export function hasMixedCheckoutModes(product: any): boolean {
  const cats = Array.isArray(product?.priceCategories) ? (product.priceCategories as any[]) : [];
  let sawRaffle = false;
  let sawFcfs = false;
  for (const cat of cats) {
    if (getSizeCheckoutMode(product, cat?.size) === 'RAFFLE') sawRaffle = true;
    else sawFcfs = true;
    if (sawRaffle && sawFcfs) return true;
  }
  return false;
}

/** size → effective checkout mode, for badges / admin summaries. */
export function sizeCheckoutModes(product: any): Record<string, 'RAFFLE' | 'FCFS'> {
  const cats = Array.isArray(product?.priceCategories) ? (product.priceCategories as any[]) : [];
  const out: Record<string, 'RAFFLE' | 'FCFS'> = {};
  for (const cat of cats) {
    const size = String(cat?.size || '').trim();
    if (size) out[size] = getSizeCheckoutMode(product, size);
  }
  return out;
}
