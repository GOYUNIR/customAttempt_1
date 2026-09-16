/**
 * CARTS (Postgres-backed) — `public.carts` / `public.cart_items`
 * (supabase/migrations/00009_commerce_b2b_core.sql). Every read/write is
 * scoped by `tenant_id`; see lib/inventory.ts's header for the storage-split
 * rationale (Postgres = source of truth, Redis = locks/rate-limits only).
 *
 * NOT wired into any live route yet — see the session's summary.
 */

import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

export type CartItem = {
  id: string;
  variantId: string;
  quantity: number;
  unitPriceCents: number;
};

export type Cart = {
  id: string;
  tenantId: string;
  customerId: string | null;
  status: 'active' | 'converted' | 'abandoned';
};

function assertSupabase(): void {
  if (!getDb().configured) {
    throw new Error('Postgres carts require Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

/** Find the customer's active cart for this tenant, or create one. A
 *  customer has at most one ACTIVE cart per tenant at a time (converted/
 *  abandoned carts are left as history, not reused). */
export async function getOrCreateActiveCart(tenantId: string, customerId: string): Promise<Cart> {
  assertSupabase();
  const db = getDb();
  const existing = await db.select<{ id: string; tenant_id: string; customer_id: string | null; status: Cart['status'] }>('carts', {
    where: { tenant_id: eq(tenantId), customer_id: eq(customerId), status: eq('active') },
    select: ['id', 'tenant_id', 'customer_id', 'status'],
    limit: 1,
  });
  if (Array.isArray(existing) && existing.length > 0) {
    const row = existing[0];
    return { id: row.id, tenantId: row.tenant_id, customerId: row.customer_id, status: row.status };
  }
  const created = await db.insert<{ id: string; tenant_id: string; customer_id: string | null; status: Cart['status'] }>('carts', {
    tenant_id: tenantId,
    customer_id: customerId,
    status: 'active',
  });
  const row = created[0];
  return { id: row.id, tenantId: row.tenant_id, customerId: row.customer_id, status: row.status };
}

export async function listCartItems(tenantId: string, cartId: string): Promise<CartItem[]> {
  assertSupabase();
  const rows = await getDb().select<{ id: string; variant_id: string; quantity: number; unit_price_cents: number }>('cart_items', {
    where: { tenant_id: eq(tenantId), cart_id: eq(cartId) },
    select: ['id', 'variant_id', 'quantity', 'unit_price_cents'],
  });
  return (rows || []).map((r) => ({
    id: r.id,
    variantId: r.variant_id,
    quantity: Number(r.quantity) || 0,
    unitPriceCents: Number(r.unit_price_cents) || 0,
  }));
}

/** Add a line to the cart. Does NOT merge with an existing line for the same
 *  variant — callers that want "increment quantity if already present"
 *  should read listCartItems() first and decide (kept explicit rather than
 *  silently merging, since a B2B cart may legitimately want two lines at
 *  different negotiated prices). */
export async function addCartItem(
  tenantId: string,
  cartId: string,
  variantId: string,
  quantity: number,
  unitPriceCents: number,
): Promise<CartItem> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const created = await getDb().insert<{ id: string; variant_id: string; quantity: number; unit_price_cents: number }>('cart_items', {
    tenant_id: tenantId,
    cart_id: cartId,
    variant_id: variantId,
    quantity: qty,
    unit_price_cents: Math.max(0, Math.round(unitPriceCents) || 0),
  });
  const row = created[0];
  return { id: row.id, variantId: row.variant_id, quantity: Number(row.quantity) || 0, unitPriceCents: Number(row.unit_price_cents) || 0 };
}

export async function removeCartItem(tenantId: string, cartItemId: string): Promise<void> {
  assertSupabase();
  await getDb().remove('cart_items', { where: { tenant_id: eq(tenantId), id: eq(cartItemId) } });
}

export async function markCartConverted(tenantId: string, cartId: string): Promise<void> {
  assertSupabase();
  // returning: 'default' — the legacy PATCH sent no Prefer header.
  await getDb().update(
    'carts',
    { where: { tenant_id: eq(tenantId), id: eq(cartId) } },
    { status: 'converted' },
    { returning: 'default' },
  );
}
