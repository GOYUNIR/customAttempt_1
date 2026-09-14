/**
 * CARTS (Postgres-backed) — `public.carts` / `public.cart_items`
 * (supabase/migrations/00009_commerce_b2b_core.sql). Every read/write is
 * scoped by `tenant_id`; see lib/inventory.ts's header for the storage-split
 * rationale (Postgres = source of truth, Redis = locks/rate-limits only).
 *
 * NOT wired into any live route yet — see the session's summary.
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

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
  if (!supabaseServiceConfigured()) {
    throw new Error('Postgres carts require Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

/** Find the customer's active cart for this tenant, or create one. A
 *  customer has at most one ACTIVE cart per tenant at a time (converted/
 *  abandoned carts are left as history, not reused). */
export async function getOrCreateActiveCart(tenantId: string, customerId: string): Promise<Cart> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const existing = (await supabaseRestFetch(
    `/carts?tenant_id=eq.${encodeURIComponent(tenantId)}&customer_id=eq.${encodeURIComponent(customerId)}&status=eq.active&select=id,tenant_id,customer_id,status&limit=1`,
    { key: serviceRoleKey },
  )) as Array<{ id: string; tenant_id: string; customer_id: string | null; status: Cart['status'] }>;
  if (Array.isArray(existing) && existing.length > 0) {
    const row = existing[0];
    return { id: row.id, tenantId: row.tenant_id, customerId: row.customer_id, status: row.status };
  }
  const created = (await supabaseRestFetch('/carts', {
    key: serviceRoleKey,
    method: 'POST',
    body: { tenant_id: tenantId, customer_id: customerId, status: 'active' },
    prefer: 'return=representation',
  })) as Array<{ id: string; tenant_id: string; customer_id: string | null; status: Cart['status'] }>;
  const row = created[0];
  return { id: row.id, tenantId: row.tenant_id, customerId: row.customer_id, status: row.status };
}

export async function listCartItems(tenantId: string, cartId: string): Promise<CartItem[]> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch(
    `/cart_items?tenant_id=eq.${encodeURIComponent(tenantId)}&cart_id=eq.${encodeURIComponent(cartId)}&select=id,variant_id,quantity,unit_price_cents`,
    { key: serviceRoleKey },
  )) as Array<{ id: string; variant_id: string; quantity: number; unit_price_cents: number }>;
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
  const { serviceRoleKey } = readSupabaseEnv();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const created = (await supabaseRestFetch('/cart_items', {
    key: serviceRoleKey,
    method: 'POST',
    body: { tenant_id: tenantId, cart_id: cartId, variant_id: variantId, quantity: qty, unit_price_cents: Math.max(0, Math.round(unitPriceCents) || 0) },
    prefer: 'return=representation',
  })) as Array<{ id: string; variant_id: string; quantity: number; unit_price_cents: number }>;
  const row = created[0];
  return { id: row.id, variantId: row.variant_id, quantity: Number(row.quantity) || 0, unitPriceCents: Number(row.unit_price_cents) || 0 };
}

export async function removeCartItem(tenantId: string, cartItemId: string): Promise<void> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  await supabaseRestFetch(
    `/cart_items?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(cartItemId)}`,
    { key: serviceRoleKey, method: 'DELETE' },
  );
}

export async function markCartConverted(tenantId: string, cartId: string): Promise<void> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  await supabaseRestFetch(
    `/carts?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(cartId)}`,
    { key: serviceRoleKey, method: 'PATCH', body: { status: 'converted' } },
  );
}
