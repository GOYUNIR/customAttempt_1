/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POSTGRES READ, WITH FALLBACK — the actual "cutover switch" for reads.
 *
 * SCOPE — this is deliberately narrow: cart contents only. The full
 * storefront catalog route (app/api/store/route.ts) resolves drop
 * scheduling, admin live-apply overrides, theme colors, social-proof
 * counters, and shared-pool aggregation across synced products — none of
 * which are commerce ENTITIES with a relational home (they're tenant
 * CONFIGURATION, correctly modeled as the JSON blobs they already are in
 * Redis/`store_kv`). A cart is a much simpler shape (a customer + a list of
 * variant/quantity pairs) with a clean, already-built Postgres equivalent
 * (lib/carts.ts), so it's the one read this session cuts over for real.
 *
 * SAFETY — every function here returns `null` (never throws) on ANY
 * failure OR when Postgres simply has no data for this customer yet (not
 * backfilled, or `USE_POSTGRES_PRIMARY` is off) — the caller's contract is
 * "null means fall back to Redis, exactly like before". This is what makes
 * the cutover safe to ship with zero live testing: the worst case, by
 * construction, is identical to today's behavior.
 */

import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { isPostgresPrimaryEnabled } from '@/lib/feature-flags';

export type CartSyncItem = {
  productId: string;
  name: string;
  size: string;
  price: number;
  productType: string;
  checkoutMode: string;
};

type EmbeddedCartItemRow = {
  quantity: number;
  unit_price_cents: number;
  product_variants: {
    option_label: string;
    checkout_mode: string;
    products: { external_id: string | null; name: string } | null;
  } | null;
};

/**
 * Read a signed-in customer's cart from Postgres, in the EXACT shape
 * app/api/cart/sync's GET already returns to the client. Returns null (not
 * an empty array — a real empty cart IS `[]`) whenever the read can't be
 * trusted as complete: the flag is off, Supabase isn't configured, no
 * Postgres customer/cart exists yet for this email, or any request fails.
 */
export async function readCartItemsFromPostgres(tenantId: string, email: string): Promise<CartSyncItem[] | null> {
  if (!isPostgresPrimaryEnabled()) return null;
  if (!getDb().configured) return null;
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;

  try {
    const db = getDb();
    const customerRows = await db.select<{ id: string }>('customers', {
      where: { tenant_id: eq(tenantId), email: eq(normalized) },
      select: ['id'],
      limit: 1,
    });
    const customerId = customerRows?.[0]?.id;
    if (!customerId) return null; // not backfilled yet — fall back

    const cartRows = await db.select<{ id: string }>('carts', {
      where: { tenant_id: eq(tenantId), customer_id: eq(customerId), status: eq('active') },
      select: ['id'],
      limit: 1,
    });
    const cartId = cartRows?.[0]?.id;
    if (!cartId) return null; // no Postgres cart yet — fall back

    const itemRows = await db.select<EmbeddedCartItemRow>('cart_items', {
      where: { tenant_id: eq(tenantId), cart_id: eq(cartId) },
      select: [
        'quantity',
        'unit_price_cents',
        {
          relation: 'product_variants',
          columns: ['option_label', 'checkout_mode', { relation: 'products', columns: ['external_id', 'name'] }],
        },
      ],
    });

    const items: CartSyncItem[] = [];
    for (const row of itemRows || []) {
      const variant = row.product_variants;
      const product = variant?.products;
      // A variant/product that failed to embed (deleted, or a malformed
      // row) makes this customer's read untrustworthy as a WHOLE — better
      // to fall back to Redis for their entire cart than silently drop one
      // line item the customer expects to see.
      if (!variant || !product?.external_id) return null;
      items.push({
        productId: product.external_id,
        name: product.name,
        size: variant.option_label,
        price: Math.max(0, Number(row.unit_price_cents) || 0) / 100,
        productType: '',
        checkoutMode: String(variant.checkout_mode || 'fcfs').toUpperCase(),
      });
    }
    return items;
  } catch {
    return null; // any failure — fall back, never break the cart page
  }
}
