/**
 * INVENTORY lookups (Postgres) and the sale recorder the draw engines use.
 *
 * Stock itself changes ONLY through the stock ledger (lib/stock.ts,
 * supabase/migrations/00037): holds, sales, counts and adjustments are atomic
 * Postgres functions that write their movement in the same transaction.
 * tests/stock-writes.test.ts fails if runtime code writes inventory_levels
 * any other way.
 */

import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { commitSale } from '@/lib/stock';

export type InventoryLevel = {
  variantId: string;
  quantityAvailable: number;
  quantityReserved: number;
};

function assertSupabase(): void {
  if (!getDb().configured) {
    throw new Error('Postgres inventory requires Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

/**
 * Resolve the Postgres `product_variants.id` for a Redis product+size pair,
 * via the same `products.external_id` / `product_variants.option_label`
 * mapping `scripts/migrate-redis-to-supabase.ts` writes on backfill. Returns
 * null when no matching row exists — the caller (a checkout route gated by
 * `USE_POSTGRES_PRIMARY`) must fail closed in that case rather than guess,
 * since a null result usually means the backfill hasn't run for this
 * product yet (see DEPLOYMENT.md's rollout sequence).
 */
export async function resolveVariantId(tenantId: string, externalProductId: string, size: string): Promise<string | null> {
  assertSupabase();
  const db = getDb();
  const products = await db.select<{ id: string }>('products', {
    where: { tenant_id: eq(tenantId), external_id: eq(externalProductId) },
    select: ['id'],
    limit: 1,
  });
  const productId = products?.[0]?.id;
  if (!productId) return null;
  const variants = await db.select<{ id: string }>('product_variants', {
    where: { product_id: eq(productId), option_label: eq(size) },
    select: ['id'],
    limit: 1,
  });
  return variants?.[0]?.id || null;
}

/** Read the current inventory row for one variant. Returns null when no row
 *  exists yet (a variant with no inventory_levels row is treated as 0/0 by
 *  callers, not an error — most catalogs backfill this lazily on first
 *  stock-in rather than pre-creating a row per variant). */
export async function getInventoryLevel(tenantId: string, variantId: string): Promise<InventoryLevel | null> {
  assertSupabase();
  const rows = await getDb().select<{ variant_id: string; quantity_available: number; quantity_reserved: number }>('inventory_levels', {
    where: { tenant_id: eq(tenantId), variant_id: eq(variantId) },
    select: ['variant_id', 'quantity_available', 'quantity_reserved'],
    limit: 1,
  });
  const row = rows?.[0];
  if (!row) return null;
  return {
    variantId: row.variant_id,
    quantityAvailable: Number(row.quantity_available) || 0,
    quantityReserved: Number(row.quantity_reserved) || 0,
  };
}

// decrementInventory / restockInventory were removed (2026-09-27): they wrote
// inventory_levels directly, outside the stock ledger (00037). Every stock
// change now goes through lib/stock.ts; tests/stock-writes.test.ts keeps it so.

/**
 * Decrement stock for a COMPLETED sale, by the KV-style product id + size the
 * checkout/draw paths carry.
 *
 * WHY THIS EXISTS. Four sites (checkout/direct, both stripe/webhook inventory
 * writes, lib/draw.ts) decremented the KV live-state blob under withRedisLock
 * and, on contention, did this:
 *
 *     if (!lockResult.ok) await decrementInventory();   // UNLOCKED
 *
 * A deliberate unlocked read-modify-write. That branch was effectively dead
 * while the lock was broken, because acquisition always "succeeded" -- so
 * fixing the lock to genuinely exclude would have started routing real
 * contention into an unlocked decrement, i.e. made oversell MORE likely. The
 * lock fix and this had to land together.
 *
 * All four callers run AFTER the customer is charged, so refusing is not an
 * option and skipping the decrement oversells. The only correct answer is an
 * atomic decrement, which is what decrementInventory now provides: an atomic
 * lock plus a compare-and-swap with bounded retry against inventory_levels.
 *
 * Never throws. A post-charge failure is logged for reconciliation, because
 * throwing here would fail a Stripe webhook that already succeeded (Stripe
 * would retry a completed charge) or abort a draw mid-payout.
 */
export async function decrementForSale(opts: {
  tenantId: string;
  externalProductId: string;
  size: string;
  quantity?: number;
  context: string;
  /** What was paid (the PaymentIntent id). REQUIRED: the stock ledger
   *  (00037) applies a sale once per reference, so a retried draw can never
   *  take the same unit twice. */
  reference: string;
}): Promise<{ ok: boolean; remaining: number | null; reason?: string }> {
  const qty = Math.max(1, Math.floor(opts.quantity ?? 1));
  try {
    const variantId = await resolveVariantId(opts.tenantId, opts.externalProductId, opts.size);
    if (!variantId) {
      console.error(
        `[${opts.context}] INVENTORY NOT DECREMENTED — no variant for ${opts.externalProductId}/${opts.size}. ` +
          'A sale completed and stock was not reduced; reconcile manually.',
      );
      return { ok: false, remaining: null, reason: 'no_variant' };
    }
    // Through the stock ledger: one movement, once per reference, never
    // refusing a paid sale (a shortfall is recorded and shown instead).
    const [line] = await commitSale(opts.tenantId, null, [{ variantId, quantity: qty }], opts.reference);
    if (!line?.applied && line?.reason !== 'already') {
      console.error(`[${opts.context}] INVENTORY NOT DECREMENTED — ${line?.reason || 'no result'} for ${opts.externalProductId}/${opts.size} (${opts.reference}); reconcile manually.`);
      return { ok: false, remaining: null, reason: line?.reason || 'failed' };
    }
    if ((line.shortfall || 0) > 0) {
      console.error(`[${opts.context}] OVERSOLD by ${line.shortfall} — ${opts.externalProductId}/${opts.size} (${opts.reference})`);
    }
    return { ok: true, remaining: line.remaining ?? null };
  } catch (err) {
    console.error(`[${opts.context}] inventory decrement threw`, (err as Error)?.message || err);
    return { ok: false, remaining: null, reason: 'threw' };
  }
}
