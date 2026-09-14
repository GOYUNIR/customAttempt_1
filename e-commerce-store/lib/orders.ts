/**
 * ORDERS (Postgres-backed) — `public.orders` / `public.order_line_items`
 * (supabase/migrations/00009_commerce_b2b_core.sql). See lib/inventory.ts's
 * header for the storage-split rationale.
 *
 * NOT wired into any live route yet — see the session's summary. In
 * particular, this module does NOT talk to Stripe: creating an order here
 * records what was decided to be charged, the same separation the existing
 * Redis-based checkout keeps (archiveEntry() records the ledger row; the
 * Stripe call and the ledger write are separate steps in every existing
 * checkout route) — wiring an order to a real payment is the live-checkout
 * integration this session deliberately isn't doing blind.
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { decrementInventory, restockInventory, type DecrementResult } from '@/lib/inventory';
import { decrementSharedPoolById, restockSharedPoolById, type PoolDecrementResult } from '@/lib/raffle';

export type OrderLineInput = {
  variantId: string;
  quantity: number;
  unitPriceCents: number;
};

export type CreateOrderInput = {
  tenantId: string;
  companyId?: string | null;
  customerId?: string | null;
  orderRef: string;
  lines: OrderLineInput[];
  discountCents?: number;
  taxCents?: number;
  currency?: string;
  /** Net terms (0/15/30/60 days) — when > 0, `net_terms_due_at` is set and
   *  `payment_status` starts as 'invoiced' instead of 'unpaid'. */
  netTermsDays?: 0 | 15 | 30 | 60;
};

export type CreateOrderResult =
  | { ok: true; orderId: string; orderRef: string; totalCents: number }
  | { ok: false; reason: 'insufficient_stock'; variantId: string }
  | { ok: false; reason: 'raffle_requires_entry'; variantId: string }
  | { ok: false; reason: 'no_lines' };

function assertSupabase(): void {
  if (!supabaseServiceConfigured()) {
    throw new Error('Postgres orders require Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

type ReservationTarget =
  | { kind: 'variant'; variantId: string; quantity: number }
  | { kind: 'pool'; poolId: string; variantId: string; quantity: number };

/** Reserve one order line's stock: a variant whose `checkout_mode` is
 *  'raffle' can never be bought directly here — a raffle sale only becomes
 *  an order AFTER lib/raffle.ts's `executeDraw` picks a winner and they're
 *  charged (see lib/postgres-shadow-write.ts). A variant with a
 *  `shared_pool_id` draws from that pool instead of its own row (migration
 *  00012's precedence rule). */
async function reserveLine(tenantId: string, line: OrderLineInput, serviceRoleKey: string): Promise<
  | { ok: true; target: ReservationTarget }
  | { ok: false; reason: 'insufficient_stock' | 'raffle_requires_entry' }
> {
  const variantRows = (await supabaseRestFetch(
    `/product_variants?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(line.variantId)}&select=id,checkout_mode,shared_pool_id&limit=1`,
    { key: serviceRoleKey },
  )) as Array<{ id: string; checkout_mode: string; shared_pool_id: string | null }>;
  const variant = variantRows?.[0];
  if (variant?.checkout_mode === 'raffle') {
    return { ok: false, reason: 'raffle_requires_entry' };
  }

  if (variant?.shared_pool_id) {
    const result: PoolDecrementResult = await decrementSharedPoolById(tenantId, variant.shared_pool_id, line.quantity);
    if (!result.ok) return { ok: false, reason: 'insufficient_stock' };
    return { ok: true, target: { kind: 'pool', poolId: variant.shared_pool_id, variantId: line.variantId, quantity: line.quantity } };
  }

  const result: DecrementResult = await decrementInventory(tenantId, line.variantId, line.quantity);
  if (!result.ok) return { ok: false, reason: 'insufficient_stock' };
  return { ok: true, target: { kind: 'variant', variantId: line.variantId, quantity: line.quantity } };
}

async function rollbackReservation(tenantId: string, target: ReservationTarget): Promise<void> {
  if (target.kind === 'pool') {
    await restockSharedPoolById(tenantId, target.poolId, target.quantity);
  } else {
    await restockInventory(tenantId, target.variantId, target.quantity);
  }
}

/**
 * Create an order: reserves stock for every line FIRST (atomically, line by
 * line — per-variant inventory or a shared pool, whichever the variant's
 * `checkout_mode`/`shared_pool_id` calls for), then writes the order + line
 * items only once every line's stock is confirmed available. If a later
 * line fails after earlier lines already reserved, the earlier reservations
 * are rolled back rather than left as a silent stock leak.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  assertSupabase();
  if (!input.lines || input.lines.length === 0) return { ok: false, reason: 'no_lines' };
  const { serviceRoleKey } = readSupabaseEnv();

  const reserved: ReservationTarget[] = [];
  for (const line of input.lines) {
    const result = await reserveLine(input.tenantId, line, serviceRoleKey);
    if (!result.ok) {
      // Roll back everything reserved so far for this order attempt.
      await Promise.all(reserved.map((t) => rollbackReservation(input.tenantId, t)));
      return { ok: false, reason: result.reason, variantId: line.variantId };
    }
    reserved.push(result.target);
  }

  const subtotalCents = input.lines.reduce((sum, l) => sum + l.unitPriceCents * Math.max(1, Math.floor(l.quantity)), 0);
  const discountCents = Math.max(0, input.discountCents || 0);
  const taxCents = Math.max(0, input.taxCents || 0);
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);
  const netTermsDays = input.netTermsDays || 0;
  const netTermsDueAt = netTermsDays > 0 ? new Date(Date.now() + netTermsDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const orderRows = (await supabaseRestFetch('/orders', {
    key: serviceRoleKey,
    method: 'POST',
    body: {
      tenant_id: input.tenantId,
      company_id: input.companyId ?? null,
      customer_id: input.customerId ?? null,
      order_ref: input.orderRef,
      status: 'confirmed',
      payment_status: netTermsDays > 0 ? 'invoiced' : 'unpaid',
      subtotal_cents: subtotalCents,
      discount_cents: discountCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      currency: input.currency || 'usd',
      net_terms_due_at: netTermsDueAt,
    },
    prefer: 'return=representation',
  })) as Array<{ id: string; order_ref: string }>;
  const order = orderRows?.[0];
  if (!order) {
    // Order row failed to write after inventory was already reserved —
    // restock everything rather than strand it as phantom-reserved stock.
    await Promise.all(reserved.map((t) => rollbackReservation(input.tenantId, t)));
    throw new Error('Failed to create order row after reserving inventory.');
  }

  await supabaseRestFetch('/order_line_items', {
    key: serviceRoleKey,
    method: 'POST',
    body: input.lines.map((l) => ({
      tenant_id: input.tenantId,
      order_id: order.id,
      variant_id: l.variantId,
      quantity: Math.max(1, Math.floor(l.quantity)),
      unit_price_cents: Math.max(0, Math.round(l.unitPriceCents)),
      line_total_cents: Math.max(0, Math.round(l.unitPriceCents)) * Math.max(1, Math.floor(l.quantity)),
    })),
  });

  return { ok: true, orderId: order.id, orderRef: order.order_ref, totalCents };
}

export async function getOrder(tenantId: string, orderId: string) {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch(
    `/orders?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`,
    { key: serviceRoleKey },
  )) as Array<Record<string, unknown>>;
  return rows?.[0] ?? null;
}

export async function listOrders(tenantId: string, opts: { companyId?: string; status?: string } = {}) {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  let path = `/orders?tenant_id=eq.${encodeURIComponent(tenantId)}&select=id,order_ref,status,payment_status,total_cents,currency,created_at&order=created_at.desc`;
  if (opts.companyId) path += `&company_id=eq.${encodeURIComponent(opts.companyId)}`;
  if (opts.status) path += `&status=eq.${encodeURIComponent(opts.status)}`;
  return (await supabaseRestFetch(path, { key: serviceRoleKey })) as Array<Record<string, unknown>>;
}

export async function updateOrderStatus(tenantId: string, orderId: string, status: string): Promise<void> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  await supabaseRestFetch(
    `/orders?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(orderId)}`,
    { key: serviceRoleKey, method: 'PATCH', body: { status } },
  );
}
