/**
 * STOCK: holds + movements (supabase/migrations/00037). The ONE way stock
 * changes once the rollout is complete.
 *
 *   on hand     units not yet sold (inventory_levels.quantity_available)
 *   held        set aside for an open checkout / a drawn raffle winner
 *   available   on hand - held: what a shopper can buy (the stock_levels view)
 *
 * Each operation is ONE Postgres function call, atomic under a row lock, that
 * writes its movement in the same transaction and refuses a variant that is
 * not the given store's. The rules are proven in tests/stock-sql.test.ts
 * (real Postgres) and scripts/verify-stock-race.ts (production, concurrent).
 */
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

/** Stripe Checkout's minimum session life is 30 minutes; a minute of slack. */
export const CHECKOUT_SESSION_SECONDS = 31 * 60;
/** A checkout hold outlives its session, so a payment made in the session's
 *  last second still finds its hold. A payment after a hold lapsed is still
 *  recorded (stock stops at 0 and the shortfall is flagged). */
export const CHECKOUT_HOLD_SECONDS = 36 * 60;

export type StockItem = { variantId: string; quantity: number };
export type ReserveResult =
  | { ok: true; already?: 'held' | 'converted'; expiresAt?: string | null }
  | { ok: false; reason: 'insufficient' | 'no_stock_row' | 'bad_quantity'; variantId?: string; available?: number };
export type SaleLine = { variantId: string; applied: boolean; remaining?: number; shortfall?: number; reason?: string };
export type LevelResult = { ok: true; before: number; onHand: number; held: number; unchanged?: boolean } | { ok: false; reason: string; onHand?: number };

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { serviceRoleKey } = readSupabaseEnv();
  return (await supabaseRestFetch('/rpc/' + fn, { key: serviceRoleKey, method: 'POST', body: args, prefer: 'return=representation' })) as T;
}
const itemsJson = (items: StockItem[]) => items.map((i) => ({ variant_id: i.variantId, quantity: Math.floor(i.quantity) }));

/** Hold these units for one checkout (or winner), all or none. Idempotent per key. */
export async function reserveStock(tenantId: string, holdKey: string, items: StockItem[], ttlSeconds: number | null, reference?: string): Promise<ReserveResult> {
  const r: any = await rpc('stock_reserve', { p_tenant: tenantId, p_hold_key: holdKey, p_items: itemsJson(items), p_ttl_seconds: ttlSeconds, p_reference: reference ?? null });
  if (r?.ok) return { ok: true, already: r.already, expiresAt: r.expires_at ?? null };
  return { ok: false, reason: r?.reason || 'insufficient', variantId: r?.variant_id, available: r?.available };
}

/** Give a checkout's (or a declined winner's) units back. Returns holds released. */
export async function releaseStock(tenantId: string, holdKey: string): Promise<number> {
  return Number(await rpc('stock_release', { p_tenant: tenantId, p_hold_key: holdKey })) || 0;
}

/** A PAID sale: on hand down once per reference, the key's holds converted. */
export async function commitSale(tenantId: string, holdKey: string | null, items: StockItem[], reference: string): Promise<SaleLine[]> {
  const r: any = await rpc('stock_commit_sale', { p_tenant: tenantId, p_hold_key: holdKey, p_items: itemsJson(items), p_reference: reference });
  return ((r?.items || []) as any[]).map((i) => ({ variantId: String(i.variant_id), applied: i.applied === true, remaining: i.remaining, shortfall: i.shortfall, reason: i.reason }));
}

/** Merchant: a physical count. */
export async function setStock(tenantId: string, variantId: string, count: number, actor: string, note?: string): Promise<LevelResult> {
  const r: any = await rpc('stock_set', { p_tenant: tenantId, p_variant: variantId, p_count: count, p_actor: actor, p_note: note ?? null });
  return r?.ok ? { ok: true, before: r.before, onHand: r.on_hand, held: r.held, unchanged: r.unchanged } : { ok: false, reason: r?.reason || 'failed', onHand: r?.on_hand };
}

/** Merchant: a relative change (restock +n, damaged -n, correction). */
export async function adjustStock(tenantId: string, variantId: string, delta: number, reason: 'restock' | 'adjust' | 'correction', actor: string, note?: string): Promise<LevelResult> {
  const r: any = await rpc('stock_adjust', { p_tenant: tenantId, p_variant: variantId, p_delta: delta, p_reason: reason, p_actor: actor, p_note: note ?? null });
  return r?.ok ? { ok: true, before: r.before, onHand: r.on_hand, held: r.held } : { ok: false, reason: r?.reason || 'failed', onHand: r?.on_hand };
}

/** On hand / held / available for a store's variants (all when none given). */
export async function stockLevels(tenantId: string, variantIds?: string[]): Promise<Map<string, { onHand: number; held: number; available: number }>> {
  const rows = (await getDb().select<any>('stock_levels', {
    where: { tenant_id: eq(tenantId), ...(variantIds && variantIds.length ? { variant_id: inList(variantIds) } : {}) },
    select: ['variant_id', 'on_hand', 'held', 'available'],
  })) as any[];
  return new Map(rows.map((r) => [String(r.variant_id), { onHand: Number(r.on_hand) || 0, held: Number(r.held) || 0, available: Number(r.available) || 0 }]));
}
