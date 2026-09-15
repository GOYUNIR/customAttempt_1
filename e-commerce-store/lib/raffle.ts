/**
 * RAFFLE / WAITLIST / SHARED-POOL (Postgres-backed) —
 * `public.raffle_entries` / `public.drop_draws` / `public.waitlist_entries` /
 * `public.shared_inventory_pools` (supabase/migrations/00012_drop_mode_schema.sql).
 *
 * See lib/inventory.ts's header for the storage-split rationale (Postgres =
 * source of truth, Redis = the atomic lock for the critical section only).
 * Winner selection is lib/raffle-draw.ts's pure, independently-tested
 * shuffle — this module is only the I/O shell around it.
 *
 * NOT wired into any live route yet — see the session's summary.
 */

import { createRedisClient } from '@/lib/server-config';
import { withRedisLock } from '@/lib/redis-lock';
import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { selectWinners } from '@/lib/raffle-draw';
import { resolveStripeClient } from '@/services/payment/factory';
import { sendWinnerEmail } from '@/lib/email';
import { getSiteUrl, fallbackSiteUrl } from '@/lib/env';

function assertSupabase(): void {
  if (!supabaseServiceConfigured()) {
    throw new Error('Postgres raffle engine requires Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

// ── Raffle entries ────────────────────────────────────────────────────────────

export type RaffleEntryInput = {
  tenantId: string;
  variantId: string;
  customerId?: string | null;
  email: string;
  paymentMethodRef?: string | null;
  promoCode?: string | null;
  discountPercent?: number | null;
  shippingAddress?: string | null;
};

export type CreateRaffleEntryResult =
  | { ok: true; entryId: string }
  | { ok: false; reason: 'already_entered' | 'error'; error?: string };

/** Submit a pending raffle entry. The table's partial unique index
 *  (tenant_id, variant_id, email) WHERE status='pending' is the actual
 *  duplicate-entry guard — this just turns that constraint violation into a
 *  clean result instead of a raw PostgREST 409. */
export async function createRaffleEntry(input: RaffleEntryInput): Promise<CreateRaffleEntryResult> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  try {
    const rows = (await supabaseRestFetch('/raffle_entries', {
      key: serviceRoleKey,
      method: 'POST',
      body: {
        tenant_id: input.tenantId,
        variant_id: input.variantId,
        customer_id: input.customerId ?? null,
        email: String(input.email || '').trim().toLowerCase(),
        payment_method_ref: input.paymentMethodRef ?? null,
        promo_code: input.promoCode ?? null,
        discount_percent: input.discountPercent ?? null,
        shipping_address: input.shippingAddress ?? null,
        status: 'pending',
      },
      prefer: 'return=representation',
    })) as Array<{ id: string }>;
    const entryId = rows?.[0]?.id;
    if (!entryId) return { ok: false, reason: 'error', error: 'No row returned.' };
    return { ok: true, entryId };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (/duplicate key|already exists|23505/i.test(message)) {
      return { ok: false, reason: 'already_entered' };
    }
    return { ok: false, reason: 'error', error: message };
  }
}

async function listPendingEntries(tenantId: string, variantId: string, serviceRoleKey: string) {
  return (await supabaseRestFetch(
    `/raffle_entries?tenant_id=eq.${encodeURIComponent(tenantId)}&variant_id=eq.${encodeURIComponent(variantId)}&status=eq.pending&select=*`,
    { key: serviceRoleKey },
  )) as Array<Record<string, unknown>>;
}

// ── Draws ─────────────────────────────────────────────────────────────────────

export type DrawExecutionResult = {
  drawId: string;
  winnerCount: number;
  entriesCount: number;
  winnerEntryIds: string[];
  notSelectedEntryIds: string[];
  /** The full winner entry rows (email, payment_method_ref, promo_code,
   *  discount_percent, shipping_address, …) — added so a caller charging
   *  winners (executeDrawWithCharging, below) doesn't need a second fetch
   *  to re-look-up what selectWinners already had in hand. */
  winners: Array<Record<string, unknown>>;
};

/**
 * Execute a draw for `variantId`: pull every pending entry, select winners
 * (lib/raffle-draw.ts), mark each entry's outcome, and record a
 * `drop_draws` row. This does NOT charge anyone — same separation the
 * existing Redis draw engine (lib/draw.ts) keeps: selecting a winner and
 * charging their card are two distinct steps.
 */
export async function executeDraw(tenantId: string, variantId: string, winnerCount: number): Promise<DrawExecutionResult> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const entries = await listPendingEntries(tenantId, variantId, serviceRoleKey);
  const { winners, notSelected } = selectWinners(entries, winnerCount);

  const nowIso = new Date().toISOString();
  const winnerIds = winners.map((e) => String(e.id));
  const notSelectedIds = notSelected.map((e) => String(e.id));

  if (winnerIds.length > 0) {
    await supabaseRestFetch(`/raffle_entries?id=in.(${winnerIds.map(encodeURIComponent).join(',')})`, {
      key: serviceRoleKey,
      method: 'PATCH',
      body: { status: 'winner', decided_at: nowIso },
    });
  }
  if (notSelectedIds.length > 0) {
    await supabaseRestFetch(`/raffle_entries?id=in.(${notSelectedIds.map(encodeURIComponent).join(',')})`, {
      key: serviceRoleKey,
      method: 'PATCH',
      body: { status: 'not_selected', decided_at: nowIso },
    });
  }

  const drawRows = (await supabaseRestFetch('/drop_draws', {
    key: serviceRoleKey,
    method: 'POST',
    body: {
      tenant_id: tenantId,
      variant_id: variantId,
      winner_count: winnerIds.length,
      entries_count: entries.length,
      summary: { winnerEntryIds: winnerIds, notSelectedEntryIds: notSelectedIds },
    },
    prefer: 'return=representation',
  })) as Array<{ id: string }>;

  return {
    drawId: drawRows?.[0]?.id || '',
    winnerCount: winnerIds.length,
    entriesCount: entries.length,
    winnerEntryIds: winnerIds,
    notSelectedEntryIds: notSelectedIds,
    winners,
  };
}

/** Mark a winning entry as charged (after a successful Stripe charge) or
 *  declined (after a failed one) — the caller (webhook/charge route) still
 *  owns the actual Stripe call; this only records the outcome. */
export async function markRaffleEntryOutcome(tenantId: string, entryId: string, outcome: 'charged' | 'declined'): Promise<void> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  await supabaseRestFetch(
    `/raffle_entries?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(entryId)}`,
    { key: serviceRoleKey, method: 'PATCH', body: { status: outcome } },
  );
}

export type ChargeOutcome = { entryId: string; email: string; status: 'charged' | 'declined'; error?: string };

/**
 * Postgres-primary execution for `app/api/admin/trigger-drop`'s manual
 * "draw this variant now" action: select winners (`executeDraw`, above —
 * this writes `status='winner'`/`decided_at` into `raffle_entries` FIRST,
 * before any charge is attempted, matching the ask that Postgres holds the
 * winner status before notification), then charge each winner's card via
 * Stripe and email them.
 *
 * Deliberately narrower than the live Redis cron engine
 * (lib/auto-draw.ts) — no recurring-cadence rollover, no promoter payouts,
 * no auto-activation. Those stay on the Redis engine; see DEPLOYMENT.md.
 * A winner with no payment method, or whose charge is declined, is marked
 * `declined` and skipped — never blocks the rest of the batch.
 */
export async function executeDrawWithCharging(
  tenantId: string,
  variantId: string,
  winnerCount: number,
): Promise<{ draw: DrawExecutionResult; charges: ChargeOutcome[] }> {
  assertSupabase();
  const draw = await executeDraw(tenantId, variantId, winnerCount);
  if (draw.winners.length === 0) return { draw, charges: [] };

  const { serviceRoleKey } = readSupabaseEnv();
  const stripe = await resolveStripeClient();

  const variantRows = (await supabaseRestFetch(
    `/product_variants?id=eq.${encodeURIComponent(variantId)}&select=option_label,price_cents,products(name)`,
    { key: serviceRoleKey },
  ).catch(() => [])) as Array<{ option_label: string; price_cents: number; products: { name: string } | null }>;
  const variant = variantRows?.[0];
  const productName = variant?.products?.name || 'Item';
  const size = variant?.option_label || 'Standard';
  const basePriceCents = Math.max(0, Number(variant?.price_cents) || 0);
  const siteUrl = getSiteUrl() || fallbackSiteUrl();

  const charges: ChargeOutcome[] = [];
  for (const entry of draw.winners) {
    const entryId = String(entry.id);
    const email = String(entry.email || '');
    const customerId = String(entry.customer_id || '');
    const paymentMethodId = String(entry.payment_method_ref || '');
    const discountPercent = Math.min(50, Math.max(0, Number(entry.discount_percent) || 0));
    const priceCents = discountPercent > 0 ? Math.max(50, Math.round(basePriceCents * (1 - discountPercent / 100))) : basePriceCents;

    if (!stripe || !customerId || !paymentMethodId) {
      await markRaffleEntryOutcome(tenantId, entryId, 'declined');
      charges.push({ entryId, email, status: 'declined', error: 'no_payment_method' });
      continue;
    }

    try {
      await stripe.paymentIntents.create({
        amount: priceCents,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        receipt_email: email || undefined,
        description: `${productName} (${size})`,
      });
      await markRaffleEntryOutcome(tenantId, entryId, 'charged');
      charges.push({ entryId, email, status: 'charged' });

      try {
        await sendWinnerEmail({
          to: email,
          product: productName,
          size,
          amountLabel: `$${(priceCents / 100).toFixed(2)}`,
          originalPrice: `$${(basePriceCents / 100).toFixed(2)}`,
          discountPercent: discountPercent > 0 ? discountPercent : undefined,
          shippingAddress: (entry.shipping_address as string) || undefined,
          siteUrl,
        });
      } catch (emailErr) {
        console.error('[raffle] winner email failed', emailErr);
      }
    } catch (err) {
      await markRaffleEntryOutcome(tenantId, entryId, 'declined');
      charges.push({ entryId, email, status: 'declined', error: (err as Error)?.message || String(err) });
    }
  }

  return { draw, charges };
}

// ── Shared inventory pools ───────────────────────────────────────────────────

export type PoolDecrementResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'insufficient_stock' | 'lock_contended' | 'no_pool'; remaining?: number };

async function getPoolLevel(tenantId: string, slug: string, serviceRoleKey: string): Promise<{ id: string; quantityAvailable: number } | null> {
  const rows = (await supabaseRestFetch(
    `/shared_inventory_pools?tenant_id=eq.${encodeURIComponent(tenantId)}&slug=eq.${encodeURIComponent(slug)}&select=id,quantity_available&limit=1`,
    { key: serviceRoleKey },
  )) as Array<{ id: string; quantity_available: number }>;
  const row = rows?.[0];
  return row ? { id: row.id, quantityAvailable: Number(row.quantity_available) || 0 } : null;
}

async function getPoolLevelById(tenantId: string, poolId: string, serviceRoleKey: string): Promise<{ id: string; quantityAvailable: number } | null> {
  const rows = (await supabaseRestFetch(
    `/shared_inventory_pools?tenant_id=eq.${encodeURIComponent(tenantId)}&id=eq.${encodeURIComponent(poolId)}&select=id,quantity_available&limit=1`,
    { key: serviceRoleKey },
  )) as Array<{ id: string; quantity_available: number }>;
  const row = rows?.[0];
  return row ? { id: row.id, quantityAvailable: Number(row.quantity_available) || 0 } : null;
}

async function decrementPoolRow(
  tenantId: string,
  pool: { id: string; quantityAvailable: number },
  qty: number,
  serviceRoleKey: string,
): Promise<PoolDecrementResult> {
  if (pool.quantityAvailable < qty) {
    return { ok: false, reason: 'insufficient_stock', remaining: pool.quantityAvailable };
  }
  const nextAvailable = pool.quantityAvailable - qty;
  const updated = (await supabaseRestFetch(
    `/shared_inventory_pools?id=eq.${encodeURIComponent(pool.id)}&quantity_available=eq.${pool.quantityAvailable}`,
    { key: serviceRoleKey, method: 'PATCH', body: { quantity_available: nextAvailable }, prefer: 'return=representation' },
  )) as Array<{ quantity_available: number }>;
  if (!Array.isArray(updated) || updated.length === 0) {
    return { ok: false, reason: 'insufficient_stock', remaining: pool.quantityAvailable };
  }
  return { ok: true, remaining: nextAvailable };
}

/** Atomic decrement of a shared pool by slug — identical lock + optimistic-
 *  concurrency pattern to lib/inventory.ts's `decrementInventory`, applied
 *  to a pool that multiple variants draw from instead of one variant's own
 *  row. */
export async function decrementSharedPool(tenantId: string, slug: string, quantity: number): Promise<PoolDecrementResult> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const redis = createRedisClient();
  if (!redis) return { ok: false, reason: 'lock_contended' };
  const { serviceRoleKey } = readSupabaseEnv();

  const lockResult = await withRedisLock(redis, `shared-pool:pg:${tenantId}:${slug}`, async (): Promise<PoolDecrementResult> => {
    const current = await getPoolLevel(tenantId, slug, serviceRoleKey);
    if (!current) return { ok: false, reason: 'no_pool' };
    return decrementPoolRow(tenantId, current, qty, serviceRoleKey);
  });

  if (!lockResult.ok) return { ok: false, reason: 'lock_contended' };
  return lockResult.value;
}

/** Same as `decrementSharedPool`, keyed by the pool's id instead of its
 *  slug — for callers (order creation) that already resolved
 *  `product_variants.shared_pool_id` and shouldn't need a second lookup to
 *  recover the slug. */
export async function decrementSharedPoolById(tenantId: string, poolId: string, quantity: number): Promise<PoolDecrementResult> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const redis = createRedisClient();
  if (!redis) return { ok: false, reason: 'lock_contended' };
  const { serviceRoleKey } = readSupabaseEnv();

  const lockResult = await withRedisLock(redis, `shared-pool:pg:id:${tenantId}:${poolId}`, async (): Promise<PoolDecrementResult> => {
    const current = await getPoolLevelById(tenantId, poolId, serviceRoleKey);
    if (!current) return { ok: false, reason: 'no_pool' };
    return decrementPoolRow(tenantId, current, qty, serviceRoleKey);
  });

  if (!lockResult.ok) return { ok: false, reason: 'lock_contended' };
  return lockResult.value;
}

/** Restock a shared pool by id (the inverse of decrementSharedPoolById) —
 *  used to roll back a partially-reserved multi-line order when a later
 *  line fails. No lock needed (a plain additive increment has no "not
 *  enough stock" race to protect against on the way up, same as
 *  lib/inventory.ts's `restockInventory`). */
export async function restockSharedPoolById(tenantId: string, poolId: string, quantity: number): Promise<void> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const { serviceRoleKey } = readSupabaseEnv();
  const current = await getPoolLevelById(tenantId, poolId, serviceRoleKey);
  if (!current) return;
  await supabaseRestFetch(`/shared_inventory_pools?id=eq.${encodeURIComponent(poolId)}`, {
    key: serviceRoleKey,
    method: 'PATCH',
    body: { quantity_available: current.quantityAvailable + qty },
  });
}

// ── Waitlist ──────────────────────────────────────────────────────────────────

export async function addToWaitlist(tenantId: string, variantId: string, email: string): Promise<{ ok: boolean; alreadyWaiting?: boolean }> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  try {
    await supabaseRestFetch('/waitlist_entries', {
      key: serviceRoleKey,
      method: 'POST',
      body: { tenant_id: tenantId, variant_id: variantId, email: String(email || '').trim().toLowerCase() },
    });
    return { ok: true };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (/duplicate key|already exists|23505/i.test(message)) {
      return { ok: true, alreadyWaiting: true };
    }
    throw err;
  }
}
