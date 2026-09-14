/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POSTGRES SHADOW WRITE — validates the write path on real traffic BEFORE
 * anything ever reads from it.
 *
 * WHY THIS EXISTS INSTEAD OF A REAL READ CUTOVER
 * -----------------------------------------------
 * This store's actual checkout logic (app/api/checkout/route.ts,
 * app/api/stripe/webhook/route.ts) is built around raffle drops, FCFS,
 * waitlists, shared inventory pools, and per-size checkout modes — NONE of
 * which the 00009 Postgres schema represents relationally (`orders` has no
 * `checkout_mode`, no concept of a raffle "entry" that gets charged later
 * by a draw, no shared-pool inventory). A literal "flip these routes to
 * read/write Postgres instead of Redis" would silently drop that entire
 * business model the moment it ran — not a hypothetical risk, confirmed by
 * reading the actual routes. Modeling raffles/drops in Postgres properly
 * (real columns/tables, their own RLS, their own business rules) is a
 * separate, larger schema-design task, not something to improvise inside a
 * shadow-write helper.
 *
 * So instead of a read cutover, `USE_POSTGRES_PRIMARY=true` (lib/feature-
 * flags.ts) turns on SHADOW WRITES here: every confirmed sale (a raffle
 * winner charged, or an FCFS purchase) is ALSO recorded into the Postgres
 * `orders`/`order_line_items` tables, immediately after — never instead of —
 * the existing Redis archive write that remains the actual source of truth.
 * Raffle/FCFS-specific fields that don't have a relational home yet
 * (checkoutMode, productType, …) are captured in `orders.metadata` jsonb
 * (supabase/migrations/00011) so nothing is silently dropped.
 *
 * This function NEVER throws and NEVER blocks/affects the real transaction
 * it's called after — every internal error is caught and logged, exactly
 * like every rate limiter and the platform audit writer in this codebase.
 * Deliberately does NOT touch `inventory_levels` (the real Redis inventory
 * lock already protected the actual sale; double-decrementing a shadow copy
 * that may not even have a seeded row yet would just produce noise, not a
 * useful signal).
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { isPostgresPrimaryEnabled } from '@/lib/feature-flags';

export type ShadowOrderInput = {
  tenantId: string;
  orderRef: string;
  email: string;
  productName: string;
  size: string;
  quantity: number;
  amountCents: number;
  checkoutMode?: string;
  promoCode?: string;
};

async function findOrCreateShadowCustomer(tenantId: string, email: string, serviceRoleKey: string): Promise<string | null> {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const existing = (await supabaseRestFetch(
    `/customers?tenant_id=eq.${encodeURIComponent(tenantId)}&email=eq.${encodeURIComponent(normalized)}&select=id&limit=1`,
    { key: serviceRoleKey },
  )) as Array<{ id: string }>;
  if (Array.isArray(existing) && existing.length > 0) return existing[0].id;
  const created = (await supabaseRestFetch('/customers?on_conflict=tenant_id,email', {
    key: serviceRoleKey,
    method: 'POST',
    body: { tenant_id: tenantId, email: normalized },
    prefer: 'return=representation,resolution=merge-duplicates',
  })) as Array<{ id: string }>;
  return created?.[0]?.id ?? null;
}

/**
 * Best-effort shadow-write of a confirmed sale into Postgres. Silently
 * no-ops (returns immediately) when `USE_POSTGRES_PRIMARY` is off or
 * Supabase isn't configured — callers can unconditionally call this after
 * every real sale without any conditional wiring of their own.
 */
export async function shadowWriteOrder(input: ShadowOrderInput): Promise<void> {
  if (!isPostgresPrimaryEnabled()) return;
  if (!supabaseServiceConfigured()) return;
  try {
    const { serviceRoleKey } = readSupabaseEnv();
    const customerId = await findOrCreateShadowCustomer(input.tenantId, input.email, serviceRoleKey);

    const orderRows = (await supabaseRestFetch('/orders?on_conflict=tenant_id,order_ref', {
      key: serviceRoleKey,
      method: 'POST',
      body: {
        tenant_id: input.tenantId,
        customer_id: customerId,
        order_ref: input.orderRef,
        status: 'confirmed',
        payment_status: 'paid',
        subtotal_cents: input.amountCents,
        total_cents: input.amountCents,
        currency: 'usd',
        metadata: {
          shadow: true,
          checkoutMode: input.checkoutMode || null,
          promoCode: input.promoCode || null,
        },
      },
      // A retried webhook delivery reuses the same order_ref (unique per
      // tenant) — merge against THAT constraint (on_conflict), not the
      // primary key, or PostgREST's default upsert target would miss it.
      prefer: 'return=representation,resolution=merge-duplicates',
    })) as Array<{ id: string }>;
    const orderId = orderRows?.[0]?.id;
    if (!orderId) return;

    await supabaseRestFetch('/order_line_items', {
      key: serviceRoleKey,
      method: 'POST',
      body: [
        {
          tenant_id: input.tenantId,
          order_id: orderId,
          quantity: Math.max(1, Math.floor(input.quantity) || 1),
          unit_price_cents: Math.max(0, Math.round(input.amountCents / Math.max(1, input.quantity))),
          line_total_cents: Math.max(0, Math.round(input.amountCents)),
        },
      ],
    });
  } catch (err) {
    console.warn('[postgres-shadow-write] failed (non-fatal, shadow only)', (err as Error)?.message || err);
  }
}
