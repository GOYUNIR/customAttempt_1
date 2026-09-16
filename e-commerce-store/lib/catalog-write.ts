/**
 * CATALOG WRITE — persist an admin-panel product into Postgres via the port.
 *
 * Phase G. The admin panel has always written the catalog to Redis
 * (`redis.hset(PRODUCTS_KEY, …)`), while Postgres held 7 columns populated by
 * a backfill that covered 4 real fields. This is the write path that makes
 * Postgres able to hold the whole product.
 *
 * FIELD SPLIT (migration 00019): real columns for anything queried,
 * constrained, or acting as a genuine control (lifecycle flags, purchase
 * limits, ordering, schedule); `config` jsonb for presentation and copy.
 * lib/postgres-catalog-read.ts reverses this exactly — the two files are a
 * matched pair and must change together.
 *
 * Structured QuerySpecs only. Raw PostgREST would not pass the fence.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

/** Fields that get their own column — everything else falls into `config`. */
const COLUMN_FIELDS = new Set([
  'id', 'name', 'slug', 'desc', 'description', 'tagline', 'notes', 'images', 'crops',
  'isActive', 'isArchived', 'isUpcoming', 'checkoutMode', 'isRaffle', 'productType',
  'maxPerEmail', 'maxPerCart', 'maxRaffleAllocationLimit',
  'sortOrder', 'totalInventory', 'goLiveAt', 'releaseEndsAt', 'categories',
  'priceCategories', 'sizeConfigs',
]);

/** Per-variant fields with their own column, excluded from a variant's config. */
const VARIANT_COLUMN_FIELDS = new Set(['size', 'price', 'checkoutMode', 'inventorySyncSlug', 'inventoryPoolId']);

export interface CatalogWriteResult {
  ok: boolean;
  productId?: string;
  variantCount?: number;
  error?: string;
}

/** Everything not owned by a real column, preserved verbatim. */
function buildConfig(product: Record<string, unknown>, columnFields: Set<string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(product)) {
    if (columnFields.has(k)) continue;
    if (v === undefined) continue;
    config[k] = v;
  }
  return config;
}

/** `images` + `crops` are parallel arrays in Redis; one array of objects here. */
function buildMediaGallery(product: Record<string, unknown>): Array<{ url: string; crop?: unknown }> {
  const images = Array.isArray(product.images) ? product.images : [];
  const crops = Array.isArray(product.crops) ? product.crops : [];
  return images
    .map((url, i) => ({ url: String(url || ''), crop: crops[i] }))
    .filter((m) => Boolean(m.url));
}

/** draft / live / archived — the constrained column, derived from the flags. */
function statusFromFlags(product: Record<string, unknown>): 'draft' | 'live' | 'archived' {
  if (product.isArchived === true) return 'archived';
  if (product.isActive === true) return 'live';
  return 'draft';
}

function normalizeMode(value: unknown): 'RAFFLE' | 'FCFS' {
  return String(value || '').toUpperCase() === 'FCFS' ? 'FCFS' : 'RAFFLE';
}

/**
 * Upsert one product and its variants. Keyed on (tenant_id, slug), the
 * existing unique constraint, so re-saving the same product updates it rather
 * than duplicating.
 *
 * Never throws: a catalog save must not 500 the admin panel while Redis is
 * still the store the storefront reads.
 */
export async function writeProductToPostgres(
  tenantId: string,
  product: Record<string, unknown>,
): Promise<CatalogWriteResult> {
  try {
    const db = getDb();
    if (!db.configured) return { ok: false, error: 'not_configured' };

    const slug = String(product.slug || '').trim();
    if (!slug) return { ok: false, error: 'missing_slug' };

    const rows = await db.insert<{ id: string }>(
      'products',
      {
        tenant_id: tenantId,
        external_id: String(product.id || ''),
        name: String(product.name || ''),
        slug,
        description: String(product.desc || product.description || ''),
        status: statusFromFlags(product),
        tagline: String(product.tagline || ''),
        marketing_notes: Array.isArray(product.notes) ? product.notes : [],
        media_gallery: buildMediaGallery(product),
        is_active: product.isActive === true,
        is_archived: product.isArchived === true,
        is_upcoming: product.isUpcoming === true,
        checkout_mode: normalizeMode(product.checkoutMode ?? (product.isRaffle === false ? 'FCFS' : 'RAFFLE')),
        product_type: String(product.productType || 'raffle'),
        max_per_email: Math.max(1, Number(product.maxPerEmail) || 1),
        max_per_cart: Math.max(1, Number(product.maxPerCart) || 1),
        max_raffle_allocation_limit: Math.max(0, Number(product.maxRaffleAllocationLimit) || 0),
        sort_order: Number(product.sortOrder) || 0,
        total_inventory: Math.max(0, Number(product.totalInventory) || 0),
        go_live_at: String(product.goLiveAt || ''),
        release_ends_at: String(product.releaseEndsAt || ''),
        categories: Array.isArray(product.categories) ? product.categories : [],
        config: buildConfig(product, COLUMN_FIELDS),
      },
      { onConflict: 'tenant_id,slug' },
    );

    const productId = rows?.[0]?.id;
    if (!productId) return { ok: false, error: 'no_product_row' };

    const cats = Array.isArray(product.priceCategories) ? product.priceCategories : [];
    const sizeConfigs = (product.sizeConfigs && typeof product.sizeConfigs === 'object'
      ? product.sizeConfigs
      : {}) as Record<string, { customDropSchedule?: unknown }>;

    let variantCount = 0;
    for (const raw of cats) {
      const cat = (raw || {}) as Record<string, unknown>;
      const size = String(cat.size || '').trim();
      if (!size) continue;
      await db.insert(
        'product_variants',
        {
          tenant_id: tenantId,
          product_id: productId,
          option_label: size,
          price_cents: Math.max(0, Math.round(Number(cat.price) * 100) || 0),
          checkout_mode: normalizeMode(cat.checkoutMode ?? product.checkoutMode),
          custom_schedule: sizeConfigs[size]?.customDropSchedule ?? {},
          config: buildConfig(cat, VARIANT_COLUMN_FIELDS),
        },
        { onConflict: 'product_id,option_label' },
      );
      variantCount++;
    }

    return { ok: true, productId, variantCount };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}

/** Remove a product (and its variants, by cascade) from Postgres. */
export async function deleteProductFromPostgres(tenantId: string, slug: string): Promise<boolean> {
  try {
    const db = getDb();
    if (!db.configured || !slug) return false;
    await db.remove('products', { where: { tenant_id: eq(tenantId), slug: eq(slug) } });
    return true;
  } catch {
    return false;
  }
}
