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
 * MARKETING/MEDIA (migration `00016`): `products.tagline`/`marketing_notes`/
 * `media_gallery` and `product_variants.custom_schedule` give tagline,
 * notes, the image gallery, and per-size drop-schedule overrides a real
 * relational home, hydrated below into `sanitizeProduct()`'s expected
 * `tagline`/`notes`/`images`/`crops`/`sizeConfigs` fields. Per-product copy
 * overrides (urgency/status line text) and sampler configs still have no
 * relational home — those stay blank until a future migration, same
 * "genuine, stated tradeoff, not a bug" as before, just a narrower gap.
 * `scripts/migrate-redis-to-supabase.ts` does NOT backfill these new
 * columns this pass — they start empty (same as `tenant_store_config`)
 * until the backfill script grows them or a real authoring UI writes them.
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

import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { isPostgresPrimaryEnabled } from '@/lib/feature-flags';
import { sizeConfigKey } from '@/lib/size-configs';
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

type PgMediaItem = { url: string; crop?: { x: number; y: number; w: number; h: number } };
type PgProduct = {
  id: string;
  external_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  tagline: string | null;
  marketing_notes: unknown;
  media_gallery: PgMediaItem[] | null;
  // 00019 — the catalog became authoritative here.
  is_active: boolean | null;
  is_archived: boolean | null;
  is_upcoming: boolean | null;
  checkout_mode: string | null;
  product_type: string | null;
  max_per_email: number | null;
  max_per_cart: number | null;
  max_raffle_allocation_limit: number | null;
  sort_order: number | null;
  total_inventory: number | null;
  go_live_at: string | null;
  release_ends_at: string | null;
  categories: unknown;
  config: Record<string, unknown> | null;
};
type PgVariant = {
  id: string;
  product_id: string;
  option_label: string;
  price_cents: number;
  checkout_mode: string | null;
  shared_pool_id: string | null;
  custom_schedule: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
};
type PgInventoryRow = { variant_id: string; quantity_available: number };
type PgPool = { id: string; slug: string; quantity_available: number };

export async function readCatalogFromPostgres(tenantId: string): Promise<PostgresCatalogRead | null> {
  if (!isPostgresPrimaryEnabled()) return null;
  if (!getDb().configured) return null;

  try {
    const db = getDb();

    // NO status filter. `status` is a pure derivation of the isActive/
    // isArchived flags (lib/catalog-write.ts's statusFromFlags), so filtering
    // status='live' here silently dropped every upcoming (draft) and archived
    // product — and, worse, meant applyLifecycle() never saw a scheduled
    // product, so its shouldGoLive transition could never fire and a drop
    // would never auto-go-live. The Redis path this replaces does an
    // unfiltered hgetall(PRODUCTS_KEY) and lets applyLifecycle decide; that is
    // the contract, and this query has to match it.
    const products = await db.select<PgProduct>('products', {
      where: { tenant_id: eq(tenantId) },
      select: [
          'id', 'external_id', 'name', 'slug', 'description', 'tagline',
          'marketing_notes', 'media_gallery',
          'is_active', 'is_archived', 'is_upcoming', 'checkout_mode', 'product_type',
          'max_per_email', 'max_per_cart', 'max_raffle_allocation_limit',
          'sort_order', 'total_inventory', 'go_live_at', 'release_ends_at',
          'categories', 'config',
        ],
    });
    if (!Array.isArray(products) || products.length === 0) return null;

    const productIds = products.map((p) => p.id);
    const variants = await db.select<PgVariant>('product_variants', {
      where: { product_id: inList(productIds) },
      select: ['id', 'product_id', 'option_label', 'price_cents', 'checkout_mode', 'shared_pool_id', 'custom_schedule', 'config'],
    });

    const variantIds = variants.map((v) => v.id);
    const inventoryRows = variantIds.length
      ? await db.select<PgInventoryRow>('inventory_levels', {
          where: { variant_id: inList(variantIds) },
          select: ['variant_id', 'quantity_available'],
        })
      : [];

    const poolIds = [...new Set(variants.map((v) => v.shared_pool_id).filter((id): id is string => Boolean(id)))];
    const pools = poolIds.length
      ? await db.select<PgPool>('shared_inventory_pools', {
          where: { id: inList(poolIds) },
          select: ['id', 'slug', 'quantity_available'],
        })
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
      const media = Array.isArray(p.media_gallery) ? p.media_gallery : [];
      const sizeConfigs: Record<string, { customDropSchedule?: Record<string, unknown> }> = {};
      for (const v of myVariants) {
        if (v.custom_schedule && typeof v.custom_schedule === 'object' && Object.keys(v.custom_schedule).length > 0) {
          sizeConfigs[sizeConfigKey(v.option_label)] = { customDropSchedule: v.custom_schedule };
        }
      }
      // `config` is spread FIRST so an explicit column always wins over a stale
      // copy of the same key that may linger in the jsonb blob. The blob is
      // presentation/copy only (00019's split rule); anything the database
      // constrains or queries is a real column below.
      const config = (p.config && typeof p.config === 'object' ? p.config : {}) as Record<string, unknown>;
      // Per-size schedule overrides come from the variant column; merge them
      // over any sizeConfigs carried in config so the column stays the source
      // of truth for the part it owns.
      const mergedSizeConfigs = {
        ...((config.sizeConfigs && typeof config.sizeConfigs === 'object' ? config.sizeConfigs : {}) as Record<string, unknown>),
        ...sizeConfigs,
      };
      return {
        ...config,
        id: p.external_id || p.id,
        name: p.name,
        slug: p.slug,
        desc: p.description || '',
        tagline: p.tagline || '',
        notes: Array.isArray(p.marketing_notes) ? p.marketing_notes : [],
        images: media.map((m) => m?.url).filter((url): url is string => Boolean(url)),
        crops: media.some((m) => m?.crop) ? media.map((m) => m?.crop || { x: 0, y: 0, w: 1, h: 1 }) : undefined,
        sizeConfigs: mergedSizeConfigs,
        // Real lifecycle columns (00019). These — not the `status` column —
        // are what applyLifecycle() reads to decide live/upcoming/archived.
        isActive: p.is_active !== null ? Boolean(p.is_active) : true,
        isArchived: Boolean(p.is_archived),
        isUpcoming: Boolean(p.is_upcoming),
        checkoutMode: String(p.checkout_mode || '').toUpperCase() === 'FCFS' ? 'FCFS' : 'RAFFLE',
        isRaffle: String(p.checkout_mode || '').toUpperCase() !== 'FCFS',
        productType: p.product_type || 'raffle',
        maxPerEmail: Math.max(1, Number(p.max_per_email) || 1),
        maxPerCart: Math.max(1, Number(p.max_per_cart) || 1),
        maxRaffleAllocationLimit: Math.max(0, Number(p.max_raffle_allocation_limit) || 0),
        sortOrder: Number(p.sort_order) || 0,
        goLiveAt: p.go_live_at || '',
        releaseEndsAt: p.release_ends_at || '',
        categories: Array.isArray(p.categories) ? p.categories : [],
        // Live inventory wins; the stored total is the configured fallback for
        // a product whose variants have no inventory rows yet.
        totalInventory: totalInventory > 0 ? totalInventory : Math.max(0, Number(p.total_inventory) || 0),
        priceCategories: myVariants.map((v) => {
          const vConfig = (v.config && typeof v.config === 'object' ? v.config : {}) as Record<string, unknown>;
          return {
            ...vConfig,
            size: v.option_label,
            price: Math.max(0, Number(v.price_cents) || 0) / 100,
            checkoutMode: String(v.checkout_mode || '').toUpperCase() === 'RAFFLE' ? 'RAFFLE' : 'FCFS',
            inventorySyncSlug: v.shared_pool_id ? poolById.get(v.shared_pool_id)?.slug : undefined,
          };
        }),
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

    // SEV-2 GUARD. This read used to end in `.catch(() => [])` with the
    // comment "a missing row just means no overrides" -- and that sentence was
    // the entire bug. tenant_store_config had never had a single row, so
    // `config: {}` flowed into mergePublicConfig, which returned pure
    // defaults, and the live storefront served the built-in theme while
    // ignoring everything the merchant had configured. Nothing alarmed,
    // because an empty config is a perfectly plausible config.
    //
    // The rule now: a tenant that HAS PRODUCTS and NO CONFIG ROW is incoherent
    // state, not a quiet default. We refuse the whole Postgres path (return
    // null) rather than silently serve defaults, and we say so loudly. A read
    // that FAILS is likewise not "no overrides" -- it is a failed read.
    //
    // A row whose config is legitimately {} is fine and passes through: the
    // distinction that matters is row-missing vs row-empty, which the old code
    // could not make. See ARCHITECTURE.md, "Standing pattern: silent fallbacks
    // are SEV candidates".
    let configRows: Array<{ config?: Record<string, unknown>; schedule_override?: Record<string, unknown>; social_override?: Record<string, unknown> }>;
    try {
      configRows = (await db.select<{ config?: Record<string, unknown>; schedule_override?: Record<string, unknown>; social_override?: Record<string, unknown> }>(
        'tenant_store_config',
        {
          where: { tenant_id: eq(tenantId) },
          select: ['config', 'schedule_override', 'social_override'],
          limit: 1,
        },
      )) as Array<{ config?: Record<string, unknown>; schedule_override?: Record<string, unknown>; social_override?: Record<string, unknown> }>;
    } catch (err) {
      console.error(
        '[postgres-catalog-read] tenant_store_config READ FAILED for tenant ' + tenantId + ' — ' +
          ((err as Error)?.message || String(err)) +
          '. Refusing the Postgres catalog path rather than serving default config.',
      );
      return null;
    }

    const configRow = configRows?.[0];
    if (!configRow) {
      console.error(
        '[postgres-catalog-read] NO tenant_store_config ROW for tenant ' + tenantId + ', but it has ' +
          products.length + ' product(s). This is the SEV-2 condition: serving default branding, ' +
          'copy and theme while the merchant believes their settings are live. Refusing the ' +
          'Postgres catalog path. Fix: npx tsx scripts/restore-store-config.ts --after <kv-branch-url> --commit',
      );
      return null;
    }

    return {
      productsRaw,
      liveStates,
      config: configRow.config || {},
      scheduleOverride: configRow.schedule_override || {},
      socialOverride: configRow.social_override || {},
    };
  } catch (err) {
    console.error('[postgres-catalog-read] failed, falling back to Redis', (err as Error)?.message || err);
    return null;
  }
}
