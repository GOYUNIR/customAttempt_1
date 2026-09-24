/**
 * STOCK GATE — the one number every oversell check reads.
 *
 * Before this, the checks that decide whether a sale or a draw may proceed
 * read `inventoryRemaining` from the KV live-state blob: the cart pre-check,
 * raffle entry, the auto-draw winner cap, admin trigger-drop. Postgres
 * `inventory_levels` has been the authoritative count for a while — the
 * storefront displays it, checkout/direct gates on it, every sale decrements
 * it — while the KV copy was kept in step by mirror writes on the hot path.
 * Mirrors drift: when the checkout webhook ran out of subrequests the KV
 * mirror was the thing it dropped, and a gate reading a drifted mirror can
 * approve a sale for a unit that no longer exists.
 *
 * Every gate now reads `liveStock`, which lib/postgres-catalog-read.ts attaches
 * to each price category straight from inventory_levels. It rides along on
 * the catalog the route has ALREADY loaded, so this costs no extra calls — and
 * the gate checks exactly the number the shopper was shown.
 *
 * FAIL CLOSED. If the stock cannot be read — the catalog fell back to KV, the
 * size is missing, or the variant belongs to a shared-inventory pool — the
 * answer is "not available", never "go ahead". Shared pools specifically:
 * Postgres decrements are strictly per-variant and ignore `shared_pool_id`,
 * so no count exists that a gate could trust. Zero production variants use a
 * pool today; the first one that does will be refused loudly rather than
 * oversold quietly (STRATEGY.md §9).
 *
 * LEGACY MODE. With USE_POSTGRES_PRIMARY off there is no Postgres count, and
 * callers keep their KV behaviour — rebaseLiveStock() is a no-op there.
 *
 * Relative imports only, so the node test runner can load it.
 */
import { isPostgresPrimaryEnabled } from './feature-flags.ts';

export type StockRead =
  | { ok: true; stock: number }
  | { ok: false; reason: 'shared_pool' | 'unknown' };

function findCategory(product: any, size: string): any | null {
  const key = String(size || '').trim().toLowerCase();
  if (!key || !Array.isArray(product?.priceCategories)) return null;
  return (product.priceCategories as any[]).find(
    (c) => String(c?.size || '').trim().toLowerCase() === key,
  ) || null;
}

/** Authoritative sellable stock for one size, or why it cannot be known. */
export function readLiveStock(product: any, size: string): StockRead {
  const category = findCategory(product, size);
  if (!category) return { ok: false, reason: 'unknown' };
  if (category.sharedPool === true) return { ok: false, reason: 'shared_pool' };
  const raw = category.liveStock;
  if (raw === null || raw === undefined || raw === '') return { ok: false, reason: 'unknown' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: 'unknown' };
  return { ok: true, stock: Math.max(0, Math.floor(n)) };
}

/**
 * For gates that also need the KV live-state record for its NON-stock fields
 * (draw counters, winners per draw): overwrite its stock with the
 * authoritative number, so every line after this — caps, sold-out decisions,
 * the eventual saveLiveState — works from the truth, and the KV mirror is
 * corrected back to it when saved. Unreadable stock becomes 0: fail closed.
 *
 * Returns the stock now on the record.
 */
export function rebaseLiveStock(
  live: { inventoryRemaining: number } | null | undefined,
  product: any,
  size: string,
  context: string,
): number {
  if (!live) return 0;
  if (!isPostgresPrimaryEnabled()) return Number(live.inventoryRemaining) || 0;
  const read = readLiveStock(product, size);
  if (read.ok) {
    live.inventoryRemaining = read.stock;
    return read.stock;
  }
  console.error('[stock-gate] ' + context + ': stock for ' + String(product?.id) + '/' + size +
    ' is ' + read.reason + ' — treating as SOLD OUT (fail closed)');
  live.inventoryRemaining = 0;
  return 0;
}
