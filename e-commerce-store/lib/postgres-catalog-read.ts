/**
 * ─────────────────────────────────────────────────────────────────────────────
 * POSTGRES CATALOG READ — Postgres-sourced data for `app/api/store/route.ts`.
 *
 * SCOPE: `app/api/store/route.ts`'s `buildStorePayload` isn't just a product
 * list — it merges tenant config (theme/schedule/social-proof/behavior
 * flags), live inventory, admin overrides, and the catalog, then runs a
 * substantial `applyLifecycle()` (go-live/archive/countdown/shared-pool
 * math) that already works correctly against Redis-shaped data. Rather than
 * re-derive that logic against Postgres (a large, unvalidated rewrite of
 * business logic that already works), this module produces data in the
 * EXACT shapes that pipeline already expects — a raw product record
 * `sanitizeProduct()` can consume unmodified, and `LiveStateRecord[]` shaped
 * exactly like `listLiveStates()`'s return — so `applyLifecycle`/
 * `sanitizeProduct`/`mergePublicConfig` run completely unchanged. Only the
 * DATA SOURCE swaps.
 *
 * HONEST LIMITATION: the Postgres schema (`products`/`product_variants`)
 * only captures a subset of what the Redis catalog record carries — name,
 * slug, description, price, checkout mode, stock. It does NOT model images,
 * tagline, notes, per-product copy overrides, custom drop schedules, or
 * sampler configs — those are storefront-authoring fields with no
 * relational home (same reasoning `lib/postgres-read-fallback.ts`'s header
 * already gives for config data). A Postgres-primary storefront therefore
 * renders products with real name/price/stock/checkout-mode but blank
 * images/tagline/notes/schedule until a real authoring flow writes those
 * fields relationally — this is a genuine, stated tradeoff, not a bug.
 *
 * `totalInventory` has no separate "original stock" concept in
 * `inventory_levels` (only `quantity_available`/`quantity_reserved`) — this
 * sets `totalInventory = inventoryRemaining`, which keeps `applyLifecycle`'s
 * sold-out logic correct (`totalInventory > 0` exactly when stock remains)
 * without a fabricated "original count".
 *
 * Returns `null` on ANY failure, no configured `tenant_store_config`/catalog
 * data, or the flag being off — the caller (`buildStorePayload`) falls back
 * to the existing Redis path unchanged, same contract as
 * `lib/postgres-read-fallback.ts`'s `readCartItemsFromPostgres`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';
import { isPostgresPrimaryEnabled } from '@/lib/feature-flags';
import type { LiveStateRecord } from '@/lib/server-config';

export type PostgresCatalogRead = {
  /** Raw product records — each one valid input to app/api/store/route.ts's
   *  local `sanitizeProduct()`, unmodified. */
  productsRaw: Array<Record<string, unknown>>;
  liveStates: LiveStateRecord[];
  config: Record<string, unknown>;
  scheduleOverride: Record<string, unknown>;
  socialOverride: Record<string, unknown>;
};

type PgProduct = { id: string; external_id: string | null; name: string; slug: string; description: string | null };
type PgVariant = { id: string; product_id: string; option_label: string; price_cents: number; checkout_mode: string | null; shared_pool_id: string | null };
type PgInventoryRow = { variant_id: string; quantity_available: number };
type PgPool = { id: string; slug: string; quantity_available: number };

export async function readCatalogFromPostgres(tenantId: string): Promise<PostgresCatalogRead | null> {
  if (!isPostgresPrimaryEnabled()) return null;
  if (!supabaseServiceConfigured()) return null;

  try {
    const { serviceRoleKey } = readSupabaseEnv();
    const key = serviceRoleKey;

    const products = (await supabaseRestFetch(
      `/products?tenant_id=eq.${encodeURIComponent(tenantId)}&status=eq.live&select=id,external_id,name,slug,description`,
      { key },
    )) as PgProduct[];
    if (!Array.isArray(products) || products.length === 0) return null;

    const productIds = products.map((p) => p.id);
    const variants = (await supabaseRestFetch(
      `/product_variants?product_id=in.(${productIds.map(encodeURIComponent).join(',')})&select=id,product_id,option_label,price_cents,checkout_mode,shared_pool_id`,
      { key },
    )) as PgVariant[];

    const variantIds = variants.map((v) => v.id);
    const inventoryRows = variantIds.length
      ? ((await supabaseRestFetch(
          `/inventory_levels?variant_id=in.(${variantIds.map(encodeURIComponent).join(',')})&select=variant_id,quantity_available`,
          { key },
        )) as PgInventoryRow[])
      : [];

    const poolIds = [...new Set(variants.map((v) => v.shared_pool_id).filter((id): id is string => Boolean(id)))];
    const pools = poolIds.length
      ? ((await supabaseRestFetch(
          `/shared_inventory_pools?id=in.(${poolIds.map(encodeURIComponent).join(',')})&select=id,slug,quantity_available`,
          { key },
        )) as PgPool[])
      : [];

    const productById = new Map(products.map((p) => [p.id, p]));
    const poolById = new Map(pools.map((pl) => [pl.id, pl]));
    const inventoryByVariant = new Map(inventoryRows.map((r) => [r.variant_id, r]));

    const productsRaw: Array<Record<string, unknown>> = products.map((p) => {
      const myVariants = variants.filter((v) => v.product_id === p.id);
      const totalInventory = myVariants.reduce((sum, v) => {
        if (v.shared_pool_id) return sum; // pool stock isn't this product's own total
        const inv = inventoryByVariant.get(v.id);
        return sum + (inv ? Math.max(0, Number(inv.quantity_available) || 0) : 0);
      }, 0);
      return {
        id: p.external_id || p.id,
        name: p.name,
        slug: p.slug,
        desc: p.description || '',
        isActive: true, // already filtered to status='live'
        totalInventory,
        priceCategories: myVariants.map((v) => ({
          size: v.option_label,
          price: Math.max(0, Number(v.price_cents) || 0) / 100,
          checkoutMode: String(v.checkout_mode || '').toUpperCase() === 'RAFFLE' ? 'RAFFLE' : 'FCFS',
          inventorySyncSlug: v.shared_pool_id ? poolById.get(v.shared_pool_id)?.slug : undefined,
        })),
      };
    });

    const liveStates: LiveStateRecord[] = [];
    for (const v of variants) {
      if (v.shared_pool_id) continue; // represented once via the pool record below
      const inv = inventoryByVariant.get(v.id);
      if (!inv) continue;
      const product = productById.get(v.product_id);
      const remaining = Math.max(0, Number(inv.quantity_available) || 0);
      liveStates.push({
        productId: `${product?.external_id || product?.id || ''}:${v.option_label}`,
        sourceProductId: product?.external_id || product?.id || '',
        productName: product?.name || '',
        slug: product?.slug || '',
        size: v.option_label,
        isActive: true,
        totalInventory: remaining,
        inventoryRemaining: remaining,
        winnersPerDraw: 1,
        drawsCompleted: 0,
        salesCompleted: 0,
      });
    }
    for (const pool of pools) {
      const remaining = Math.max(0, Number(pool.quantity_available) || 0);
      liveStates.push({
        productId: `shared:${pool.slug}`,
        productName: '',
        slug: '',
        size: '',
        isActive: true,
        totalInventory: remaining,
        inventoryRemaining: remaining,
        winnersPerDraw: 1,
        drawsCompleted: 0,
        salesCompleted: 0,
        inventorySyncSlug: pool.slug,
      });
    }

    const configRows = (await supabaseRestFetch(
      `/tenant_store_config?tenant_id=eq.${encodeURIComponent(tenantId)}&select=config,schedule_override,social_override&limit=1`,
      { key },
    ).catch(() => [])) as Array<{ config?: Record<string, unknown>; schedule_override?: Record<string, unknown>; social_override?: Record<string, unknown> }>;
    const configRow = configRows?.[0];

    return {
      productsRaw,
      liveStates,
      config: configRow?.config || {},
      scheduleOverride: configRow?.schedule_override || {},
      socialOverride: configRow?.social_override || {},
    };
  } catch (err) {
    console.error('[postgres-catalog-read] failed, falling back to Redis', (err as Error)?.message || err);
    return null;
  }
}
