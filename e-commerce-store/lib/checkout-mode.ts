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

/**
 * Resolve the purchase / inventory limits for ONE size. A size's OWN value on
 * its `priceCategories[]` entry wins, otherwise the product-level fallback is
 * used. This is the single source of truth so the admin UI, the storefront cart
 * guard and the live-state seeding all agree on what "per item" means.
 */
export function resolveSizeLimits(product: any, size?: string | null): {
  maxPerEmail: number;
  maxPerCart: number;
  maxRaffleAllocationLimit: number;
  inventory: number;
} {
  const exact = String(size || '').trim();
  const key = exact.toLowerCase();
  const cat = key && Array.isArray(product?.priceCategories)
    ? (product.priceCategories as any[]).find((c) => String(c?.size || '').trim().toLowerCase() === key)
    : null;
  const inventoryPerSize =
    product?.inventoryPerSize && typeof product.inventoryPerSize === 'object' && !Array.isArray(product.inventoryPerSize)
      ? (product.inventoryPerSize as Record<string, unknown>)
      : {};
  const perSizeStock = exact ? Number(inventoryPerSize[exact] ?? inventoryPerSize[key]) : 0;
  const productStock = Math.max(0, Number(product?.totalInventory) || 0);
  return {
    maxPerEmail: Math.max(1, Number(cat?.maxPerEmail ?? product?.maxPerEmail) || 1),
    maxPerCart: Math.max(1, Number(cat?.maxPerCart ?? product?.maxPerCart ?? product?.maxPerEmail) || 1),
    maxRaffleAllocationLimit: Math.max(0, Number(cat?.maxRaffleAllocationLimit ?? product?.maxRaffleAllocationLimit) || 0),
    inventory: perSizeStock > 0 ? perSizeStock : productStock,
  };
}

/**
 * Normalize a user-typed shared-inventory sync slug into a stable URL-safe
 * token. Shared slugs are OPTIONAL per size: when two (or more) sizes carry
 * the same slug they draw from ONE shared stock pool instead of their own.
 * Leave blank = this size keeps its own independent inventory.
 */
export function normalizeInventorySyncSlug(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Resolve the optional shared-inventory sync slug for ONE size. A size's own
 * `inventorySyncSlug` wins; there is no product-level fallback — sharing is
 * opt-in per item, because physical items are distinct SKUs with distinct
 * stock unless the operator explicitly links them.
 */
export function resolveInventorySyncSlug(product: any, size?: string | null): string {
  const key = String(size || '').trim().toLowerCase();
  if (!key || !Array.isArray(product?.priceCategories)) return '';
  const category = (product.priceCategories as any[]).find(
    (c) => String(c?.size || '').trim().toLowerCase() === key,
  );
  return normalizeInventorySyncSlug(category?.inventorySyncSlug);
}

/**
 * The live-state field name for a SHARED inventory pool. Shared pools live in
 * the same `ops:live_state` hash but under a `shared:<slug>` field so every
 * size/product that references the slug reads and writes the same counter —
 * which means the existing checkout/draw/webhook decrements "just work"
 * across products with zero per-call-site changes.
 */
export function sharedInventoryField(slug: string): string {
  const safe = normalizeInventorySyncSlug(slug);
  return safe ? `shared:${safe}` : '';
}
