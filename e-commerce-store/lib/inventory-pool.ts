/**
 * Shared Inventory Pools — bind linked items to one `inventory_pool_id` so
 * stock syncs across URLs/SKUs without ever double-selling.
 *
 * The canonical field on a size is `inventorySyncSlug` (the operator-facing
 * "Sync slug"); `inventoryPoolId` is its stable, normalized equivalent. Two (or
 * more) sizes — in ANY product — that share the same id draw from ONE shared
 * counter stored under `shared:<id>` inside the existing `ops:live_state` hash,
 * which the checkout / draw / webhook decrement paths already read and write
 * (see `lib/checkout-mode.ts`). Because the pool id IS the normalized slug, we
 * keep perfect backward compatibility with those `shared:<slug>` fields.
 *
 * Dependency: `./checkout-mode` is itself self-contained (no `@/` imports), so
 * this module stays loadable by `node --test`.
 */
import {
  normalizeInventorySyncSlug,
  resolveInventorySyncSlug,
  sharedInventoryField,
} from './checkout-mode.ts';

/** The stable `inventory_pool_id` for a sync slug (empty when unset). */
export function inventoryPoolIdFromSyncSlug(slug: unknown): string {
  return normalizeInventorySyncSlug(slug);
}

/** Resolve the `inventory_pool_id` for ONE size on a product. Empty = no pool. */
export function resolveInventoryPoolId(product: unknown, size?: string | null): string {
  const key = String(size || '').trim().toLowerCase();
  if (key && Array.isArray((product as any)?.priceCategories)) {
    const cat = ((product as any).priceCategories as any[]).find(
      (c) => String(c?.size || '').trim().toLowerCase() === key,
    );
    if (cat) {
      // An explicit pool id wins, otherwise fall back to the sync slug.
      const explicit = String(cat?.inventoryPoolId || '').trim();
      if (explicit) return normalizeInventorySyncSlug(explicit);
      return inventoryPoolIdFromSyncSlug(cat?.inventorySyncSlug);
    }
  }
  return inventoryPoolIdFromSyncSlug(resolveInventorySyncSlug(product, size));
}

/** The `ops:live_state` field name that holds a pool's remaining count. */
export function inventoryPoolField(poolId: unknown): string {
  return sharedInventoryField(normalizeInventorySyncSlug(poolId));
}

/**
 * Normalize an array of price categories so every size with a sync slug also
 * carries its canonical `inventoryPoolId`, and blank slugs are dropped. This is
 * the write-time bind step: a size can never reference a pool without the id
 * being persisted, so the read path can always resolve the pool reliably.
 */
export function bindInventoryPoolToCategories(categories: unknown): unknown[] {
  if (!Array.isArray(categories)) return [];
  return categories.map((raw: any) => {
    const out = { ...(raw || {}) };
    const slug = normalizeInventorySyncSlug(out.inventorySyncSlug || out.inventoryPoolId);
    if (slug) {
      out.inventorySyncSlug = slug;
      out.inventoryPoolId = inventoryPoolIdFromSyncSlug(slug);
    } else {
      delete out.inventorySyncSlug;
      delete out.inventoryPoolId;
    }
    return out;
  });
}

/** True when a product links at least one size into a shared inventory pool. */
export function productHasInventoryPool(product: unknown): boolean {
  return (Array.isArray((product as any)?.priceCategories) ? (product as any).priceCategories : []).some(
    (c: any) => String(c?.inventorySyncSlug || c?.inventoryPoolId || '').trim() !== '',
  );
}
