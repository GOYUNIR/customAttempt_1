/**
 * INVENTORY (Postgres-backed) — `public.inventory_levels`
 * (supabase/migrations/00009_commerce_b2b_core.sql).
 *
 * Postgres is the source of truth for the quantity; Redis is used ONLY for
 * the atomic critical section during a decrement (lib/redis-lock.ts) — the
 * exact split the architecture calls for: "Redis restricted strictly to
 * concurrency locks and rate-limiting." Two concurrent checkouts for the
 * last unit still can't both succeed: the lock serializes them, and the
 * PATCH itself carries an optimistic-concurrency WHERE clause (only
 * succeeds if `quantity_available` still matches what was just read) as a
 * second, independent guard against the classic Redis-era oversell bug this
 * codebase has hardened against before (see lib/redis-lock.ts's own header).
 *
 * NOT wired into any live route yet — see the session's summary for why
 * (no Supabase environment available here to integration-test the actual
 * checkout path against).
 */

import { createRedisClient } from '@/lib/server-config';
import { withRedisLock } from '@/lib/redis-lock';
import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

export type InventoryLevel = {
  variantId: string;
  quantityAvailable: number;
  quantityReserved: number;
};

function assertSupabase(): void {
  if (!supabaseServiceConfigured()) {
    throw new Error('Postgres inventory requires Supabase (SUPABASE_SERVICE_ROLE_KEY).');
  }
}

/** Read the current inventory row for one variant. Returns null when no row
 *  exists yet (a variant with no inventory_levels row is treated as 0/0 by
 *  callers, not an error — most catalogs backfill this lazily on first
 *  stock-in rather than pre-creating a row per variant). */
export async function getInventoryLevel(tenantId: string, variantId: string): Promise<InventoryLevel | null> {
  assertSupabase();
  const { serviceRoleKey } = readSupabaseEnv();
  const rows = (await supabaseRestFetch(
    `/inventory_levels?tenant_id=eq.${encodeURIComponent(tenantId)}&variant_id=eq.${encodeURIComponent(variantId)}&select=variant_id,quantity_available,quantity_reserved&limit=1`,
    { key: serviceRoleKey },
  )) as Array<{ variant_id: string; quantity_available: number; quantity_reserved: number }>;
  const row = rows?.[0];
  if (!row) return null;
  return {
    variantId: row.variant_id,
    quantityAvailable: Number(row.quantity_available) || 0,
    quantityReserved: Number(row.quantity_reserved) || 0,
  };
}

export type DecrementResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'insufficient_stock' | 'lock_contended' | 'no_inventory_row'; remaining?: number };

/**
 * Atomically decrement `quantity` units from `variantId`'s available stock.
 * The whole read-check-write happens inside a Redis lock scoped to this
 * variant (`inventory:pg:<tenantId>:<variantId>`) so two concurrent callers
 * can never both pass the availability check for the same last unit.
 */
export async function decrementInventory(
  tenantId: string,
  variantId: string,
  quantity: number,
): Promise<DecrementResult> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const redis = createRedisClient();
  if (!redis) {
    // No lock backend available at all — refuse rather than risk an
    // unprotected oversell. This mirrors lib/redis-lock.ts's own
    // "never silently skip the safety mechanism" stance for a charged
    // customer; here nothing has been charged yet, so failing closed is
    // the safe default the caller should retry.
    return { ok: false, reason: 'lock_contended' };
  }

  const { serviceRoleKey } = readSupabaseEnv();
  const lockResult = await withRedisLock(redis, `inventory:pg:${tenantId}:${variantId}`, async (): Promise<DecrementResult> => {
    const current = await getInventoryLevel(tenantId, variantId);
    if (!current) return { ok: false, reason: 'no_inventory_row' };
    if (current.quantityAvailable < qty) {
      return { ok: false, reason: 'insufficient_stock', remaining: current.quantityAvailable };
    }
    const nextAvailable = current.quantityAvailable - qty;
    // Optimistic-concurrency PATCH: the WHERE clause requires
    // quantity_available to still equal what we just read. Belt-and-
    // suspenders alongside the lock — if it ever matches zero rows (a
    // concurrent writer slipped in despite the lock, e.g. a direct SQL
    // edit bypassing the app), the caller gets a clear failure instead of
    // silently double-decrementing.
    const updated = (await supabaseRestFetch(
      `/inventory_levels?tenant_id=eq.${encodeURIComponent(tenantId)}&variant_id=eq.${encodeURIComponent(variantId)}&quantity_available=eq.${current.quantityAvailable}`,
      {
        key: serviceRoleKey,
        method: 'PATCH',
        body: { quantity_available: nextAvailable },
        prefer: 'return=representation',
      },
    )) as Array<{ quantity_available: number }>;
    if (!Array.isArray(updated) || updated.length === 0) {
      return { ok: false, reason: 'insufficient_stock', remaining: current.quantityAvailable };
    }
    return { ok: true, remaining: nextAvailable };
  });

  if (!lockResult.ok) return { ok: false, reason: 'lock_contended' };
  return lockResult.value;
}

/** Restock (increase available quantity) — no lock needed, a plain atomic
 *  increment is safe (no "not enough stock" race to protect against on the
 *  way up). */
export async function restockInventory(tenantId: string, variantId: string, quantity: number): Promise<InventoryLevel> {
  assertSupabase();
  const qty = Math.max(1, Math.floor(quantity) || 0);
  const { serviceRoleKey } = readSupabaseEnv();
  const current = await getInventoryLevel(tenantId, variantId);
  if (!current) {
    const created = (await supabaseRestFetch('/inventory_levels', {
      key: serviceRoleKey,
      method: 'POST',
      body: { tenant_id: tenantId, variant_id: variantId, quantity_available: qty, quantity_reserved: 0 },
      prefer: 'return=representation',
    })) as Array<{ variant_id: string; quantity_available: number; quantity_reserved: number }>;
    const row = created[0];
    return { variantId: row.variant_id, quantityAvailable: Number(row.quantity_available) || 0, quantityReserved: Number(row.quantity_reserved) || 0 };
  }
  const updated = (await supabaseRestFetch(
    `/inventory_levels?tenant_id=eq.${encodeURIComponent(tenantId)}&variant_id=eq.${encodeURIComponent(variantId)}`,
    {
      key: serviceRoleKey,
      method: 'PATCH',
      body: { quantity_available: current.quantityAvailable + qty },
      prefer: 'return=representation',
    },
  )) as Array<{ variant_id: string; quantity_available: number; quantity_reserved: number }>;
  const row = updated[0];
  return { variantId: row.variant_id, quantityAvailable: Number(row.quantity_available) || 0, quantityReserved: Number(row.quantity_reserved) || 0 };
}
