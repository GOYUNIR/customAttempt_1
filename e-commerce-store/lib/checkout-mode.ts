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

/**
 * True when a variant (a `priceCategories[]` entry) owns a shared-inventory
 * sync slug. Compares the NORMALIZED tokens (case-insensitive + trimmed)
 * against both `inventorySyncSlug` and its canonical `inventoryPoolId`.
 */
export function categoryMatchesInventorySyncSlug(category: any, slug: unknown): boolean {
  const key = normalizeInventorySyncSlug(slug);
  if (!key) return false;
  return (
    normalizeInventorySyncSlug(category?.inventorySyncSlug) === key ||
    normalizeInventorySyncSlug(category?.inventoryPoolId) === key
  );
}

/**
 * True when a product's OWN slug (or id) equals a shared-inventory slug. This
 * lets an operator link a size to a whole product by typing the product slug —
 * the product itself acts as the pool's canonical source even when none of its
 * variants carry an explicit `inventorySyncSlug`.
 */
export function productMatchesInventorySyncSlug(product: any, slug: unknown): boolean {
  const key = normalizeInventorySyncSlug(slug);
  if (!key) return false;
  return (
    normalizeInventorySyncSlug(product?.slug) === key ||
    normalizeInventorySyncSlug(product?.id) === key
  );
}

/** The resolved shared-inventory source for a sync slug. */
export interface InventorySyncSource {
  /** The source variant (a `priceCategories[]` entry) to inherit fields from. */
  category: any;
  /** The parent product that owns the source variant / slug. */
  product: any;
  /** How the source was matched — a variant's sync slug or a product's slug. */
  matchedBy: 'variant' | 'product';
}

/**
 * Find the shared-inventory source for a sync slug across an ENTIRE catalog.
 *
 * Searches case-insensitively and trimmed across BOTH variants and products:
 *   1. the active editor's own variants (unsaved edits), then its product slug;
 *   2. every product in `catalog` — each product's variants, then its own slug.
 *
 * A variant "owns" the slug via `inventorySyncSlug`/`inventoryPoolId`; a
 * product owns it via its `slug`/`id`. When a product is matched by its own
 * slug, the representative source variant is the one whose SIZE matches the
 * size being edited (falling back to the slug-carrying / first variant).
 * Returns null when no source exists — i.e. the slug starts a NEW pool.
 */
export function findInventorySyncSource(
  slug: unknown,
  catalog?: any[] | null,
  current?: any | null,
  currentIndex?: number | null,
): InventorySyncSource | null {
  const key = normalizeInventorySyncSlug(slug);
  if (!key) return null;

  const editingIndex = typeof currentIndex === 'number' ? currentIndex : -1;
  const editingSize = String(
    Array.isArray(current?.priceCategories) ? current.priceCategories[editingIndex]?.size || '' : '',
  ).trim().toLowerCase();

  const pickCategory = (product: any, excludeIndex?: number): any | null => {
    const cats = Array.isArray(product?.priceCategories) ? product.priceCategories : [];
    if (cats.length === 0) return null;
    const others = typeof excludeIndex === 'number' ? cats.filter((_: any, i: number) => i !== excludeIndex) : cats;
    if (editingSize) {
      const bySize = others.find((c: any) => String(c?.size || '').trim().toLowerCase() === editingSize);
      if (bySize) return bySize;
    }
    const withSlug = others.find((c: any) => categoryMatchesInventorySyncSlug(c, key));
    return withSlug || others[0] || null;
  };

  // 1) The active editor (unsaved edits) — same-product sharing.
  if (current && Array.isArray(current.priceCategories)) {
    const inForm = current.priceCategories.find(
      (c: any, i: number) => i !== editingIndex && categoryMatchesInventorySyncSlug(c, key),
    );
    if (inForm) return { category: inForm, product: current, matchedBy: 'variant' };
    if (productMatchesInventorySyncSlug(current, key)) {
      const picked = pickCategory(current, editingIndex);
      if (picked) return { category: picked, product: current, matchedBy: 'product' };
    }
  }

  // 2) The entire catalog — every product and every variant.
  const ownId = current ? String(current.id ?? '') : '';
  for (const p of Array.isArray(catalog) ? catalog : []) {
    if (!p) continue;
    // The active editor's FRESH state was already searched above; skip its
    // (possibly stale) catalog copy so the product can't match itself.
    if (ownId && String(p?.id ?? '') === ownId) continue;
    const inProduct = (Array.isArray(p.priceCategories) ? p.priceCategories : []).find(
      (c: any) => categoryMatchesInventorySyncSlug(c, key),
    );
    if (inProduct) return { category: inProduct, product: p, matchedBy: 'variant' };
    if (productMatchesInventorySyncSlug(p, key)) {
      const picked = pickCategory(p);
      if (picked) return { category: picked, product: p, matchedBy: 'product' };
    }
  }

  return null;
}

/**
 * Whether a size's shared-inventory SOURCE is "released".
 *
 * A size that syncs to an existing slug (`inventorySyncSlug`) draws from a
 * shared stock pool whose canonical source lives in ANOTHER product. When that
 * source product is itself live (active, not upcoming/archived) the synced size
 * can be sold directly — even when its own parent container is still DRAFT or
 * UPCOMING (unreleased). This lets checkout relax the parent-lifecycle gate for
 * synced variants without changing anything for standalone sizes.
 */
export function isSyncedSourceReleased(
  product: any,
  size?: string | null,
  catalog?: any[] | null,
): boolean {
  const slug = resolveInventorySyncSlug(product, size);
  if (!slug) return false;
  const ownId = String(product?.id ?? '');
  return (Array.isArray(catalog) ? catalog : []).some((p: any) => {
    if (!p) return false;
    // Skip the product itself — the "source" must be a DIFFERENT container.
    if (ownId && String(p?.id ?? '') === ownId) return false;
    // A source container is "released" when it is live and not scheduled/retired.
    const released =
      p.isActive !== false &&
      p.isArchived !== true &&
      p.isUpcoming !== true;
    if (!released) return false;
    // A released source "owns" the slug either as its OWN product slug, or via
    // one of its variants' sync slugs (matching the admin editor's lookup).
    if (normalizeInventorySyncSlug(p?.slug) === slug) return true;
    return Array.isArray(p?.priceCategories)
      ? p.priceCategories.some((c: any) => categoryMatchesInventorySyncSlug(c, slug))
      : false;
  });
}
