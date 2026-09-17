/**
 * CART PERSISTENCE (H7) — the write half of the signed-in cart.
 *
 * cart/sync already READ from Postgres (readCartItemsFromPostgres, Phase 2)
 * while only ever WRITING the KV blob, so the read had nothing to find and
 * always fell through. This closes that.
 *
 * Identity comes from ensureCustomer on the session email, NOT from the KV
 * user id: carts.customer_id is a uuid FK to public.customers, and the
 * storefront's own user records live in the KV `store:users` hash with their
 * passwords and verification state. Those are a separate, unresolved question
 * (see ARCHITECTURE.md) — a cart does not need it answered, it just needs a
 * durable customer row, which ensureCustomer provides.
 *
 * A cart item needs a real variant_id (uuid FK) and unit_price_cents, while
 * the browser cart carries productId + size + price. Items whose variant
 * cannot be resolved are SKIPPED and reported rather than guessed at — a cart
 * line pointing at the wrong variant would check out the wrong product.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { ensureCustomer } from '@/lib/customers';
import { resolveVariantId } from '@/lib/inventory';

export type CartItemInput = {
  productId: string;
  size: string;
  price: number;
  quantity?: number;
};

export type CartWriteResult = {
  ok: boolean;
  written: number;
  skipped: Array<{ productId: string; size: string; reason: string }>;
  error?: string;
};

/**
 * Replace the customer's active cart with `items`.
 *
 * REPLACE, not merge: the client already merges server + local once on login
 * and then posts the full cart on every change, so a merge here would
 * resurrect items the customer just removed.
 *
 * Never throws — a cart sync must not 500 a browsing session.
 */
export async function writeCartToPostgres(
  tenantId: string,
  email: string,
  items: CartItemInput[],
): Promise<CartWriteResult> {
  const skipped: CartWriteResult['skipped'] = [];
  try {
    const db = getDb();
    if (!db.configured) return { ok: false, written: 0, skipped, error: 'not_configured' };

    const customerId = await ensureCustomer(tenantId, email);
    if (!customerId) return { ok: false, written: 0, skipped, error: 'no_customer' };

    // One active cart per customer. Reuse it so the cart's id (and therefore
    // any analytics keyed on it) is stable across syncs.
    const existing = (await db.select<{ id: string }>('carts', {
      where: { tenant_id: eq(tenantId), customer_id: eq(customerId), status: eq('active') },
      select: ['id'],
      limit: 1,
    })) as Array<{ id: string }>;

    let cartId = existing?.[0]?.id;
    if (!cartId) {
      const created = (await db.insert<{ id: string }>('carts', {
        tenant_id: tenantId,
        customer_id: customerId,
        status: 'active',
      })) as Array<{ id: string }>;
      cartId = created?.[0]?.id;
    }
    if (!cartId) return { ok: false, written: 0, skipped, error: 'no_cart' };

    // Clear then insert. cart_items has no natural key to upsert on
    // (the same variant can legitimately appear once), and a replace is what
    // the caller's semantics are.
    await db.remove('cart_items', { where: { tenant_id: eq(tenantId), cart_id: eq(cartId) } });

    let written = 0;
    for (const item of items) {
      const variantId = await resolveVariantId(tenantId, String(item.productId), String(item.size));
      if (!variantId) {
        skipped.push({ productId: String(item.productId), size: String(item.size), reason: 'no_variant' });
        continue;
      }
      await db.insert('cart_items', {
        tenant_id: tenantId,
        cart_id: cartId,
        variant_id: variantId,
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        unit_price_cents: Math.max(0, Math.round(Number(item.price) * 100) || 0),
      });
      written += 1;
    }

    await db.update(
      'carts',
      { where: { tenant_id: eq(tenantId), id: eq(cartId) } },
      { updated_at: new Date().toISOString() },
      { returning: 'default' },
    );

    if (skipped.length > 0) {
      console.warn(
        '[cart-write] ' + skipped.length + ' cart line(s) skipped — no matching variant: ' +
          skipped.map((s) => s.productId + '/' + s.size).join(', '),
      );
    }
    return { ok: true, written, skipped };
  } catch (err) {
    return { ok: false, written: 0, skipped, error: (err as Error)?.message || String(err) };
  }
}
