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
import { eq, inList } from '@/lib/db/query';

/** Fields that get their own column — everything else falls into `config`. */
const COLUMN_FIELDS = new Set([
  'id', 'name', 'slug', 'desc', 'description', 'tagline', 'notes', 'images', 'crops',
  'isActive', 'isArchived', 'isUpcoming', 'checkoutMode', 'isRaffle', 'productType',
  'maxPerEmail', 'maxPerCart', 'maxRaffleAllocationLimit',
  'sortOrder', 'totalInventory', 'goLiveAt', 'releaseEndsAt', 'categories',
  'priceCategories', 'sizeConfigs',
]);

/** Per-variant fields excluded from a variant's config: the ones with their own
 *  column, plus `liveStock`/`sharedPool`, which postgres-catalog-read DERIVES
 *  from inventory_levels on every read. An admin saving a loaded product would
 *  otherwise persist a stale stock snapshot into the jsonb blob. */
const VARIANT_COLUMN_FIELDS = new Set([
  'size', 'price', 'checkoutMode', 'inventorySyncSlug', 'inventoryPoolId',
  'liveStock', 'sharedPool',
]);

export interface CatalogWriteResult {
  ok: boolean;
  productId?: string;
  /** DISTINCT variant rows that exist after the write, not price categories
   *  submitted. Two categories sharing an option_label produce ONE row. */
  variantCount?: number;
  /** Price categories that collided on option_label, with how many shared it.
   *  product_variants has unique (product_id, option_label), so an upsert
   *  silently merges them and the last one wins. That is data loss, and a
   *  caller has to be able to see it rather than infer it from a count that
   *  looks right. Empty (absent) when nothing collided. */
  duplicateLabels?: Array<{ label: string; count: number }>;
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

/**
 * Loud warning when base64 reaches products.media_gallery (Phase H1).
 *
 * Media lives in R2 now and media_gallery should hold URLs. New uploads go
 * straight to R2 via /api/admin/media/presign, so the one path that still
 * produces base64 here is re-saving a product whose images were loaded from
 * the (not yet migrated) KV blob -- which silently undoes the backfill for
 * that product, with a successful save and no visible symptom until someone
 * notices the payload grew again.
 *
 * This does NOT block the write: refusing a merchant's save over a storage
 * detail is worse than the regression. It makes the regression findable.
 * Removable once H3 moves the admin catalog off the KV blob.
 */
function warnOnBase64Media(
  gallery: Array<{ url: string; crop?: unknown }>,
  product: Record<string, unknown>,
): Array<{ url: string; crop?: unknown }> {
  const base64 = gallery.filter((m) => /^data:/i.test(String(m?.url || '')));
  if (base64.length > 0) {
    const bytes = base64.reduce((n, m) => n + String(m.url).length, 0);
    console.error(
      '[catalog-write] BASE64 MEDIA written to products.media_gallery — this undoes the R2 backfill. ' +
        `product=${String(product.slug || product.id || '?')} images=${base64.length} bytes=${bytes}. ` +
        'Cause is almost always a product re-saved from the legacy KV blob; re-run ' +
        'scripts/backfill-media-to-r2.ts --commit to move it back to R2.',
    );
  }
  return gallery;
}

/** `images` + `crops` are parallel arrays in Redis; one array of objects here. */
function buildMediaGallery(product: Record<string, unknown>): Array<{ url: string; crop?: unknown }> {
  const images = Array.isArray(product.images) ? product.images : [];
  const crops = Array.isArray(product.crops) ? product.crops : [];
  return images
    .map((url, i) => ({ url: String(url || ''), crop: crops[i] }))
    .filter((m) => Boolean(m.url));
}

/**
 * Create a missing inventory row per variant. Never updates an existing one.
 * Never throws -- a catalog save must not fail on inventory bookkeeping -- but
 * a variant left without a row cannot be sold, so failure is logged loudly.
 */
async function writeInventoryRows(
  tenantId: string,
  productId: string,
  product: Record<string, unknown>,
): Promise<void> {
  try {
    const db = getDb();
    const rows = (await db.select<{ id: string; option_label: string }>('product_variants', {
      where: { product_id: eq(productId) },
      select: ['id', 'option_label'],
    })) as Array<{ id: string; option_label: string }>;
    if (!Array.isArray(rows) || rows.length === 0) return;

    const existing = (await db.select<{ variant_id: string; quantity_available: number }>('inventory_levels', {
      where: { variant_id: inList(rows.map((r) => r.id)) },
      select: ['variant_id', 'quantity_available'],
    })) as Array<{ variant_id: string; quantity_available: number }>;
    const have = new Map((existing || []).map((r) => [r.variant_id, r.quantity_available]));

    const perSize = (product.inventoryPerSize && typeof product.inventoryPerSize === 'object'
      ? product.inventoryPerSize
      : {}) as Record<string, unknown>;

    for (const row of rows) {
      const configured = Math.max(0, Math.floor(Number(perSize[row.option_label]) || 0));
      if (have.has(row.id)) {
        const liveQty = have.get(row.id) ?? 0;
        if (configured > 0 && configured !== liveQty) {
          console.warn(
            `[catalog-write] ${String(product.slug || product.id)}/${row.option_label}: configured inventory ` +
              `${configured} differs from live stock ${liveQty}. Live stock wins — overwriting it would ` +
              'resurrect sold units. Use the inventory screen to restock.',
          );
        }
        continue;
      }
      await db.insert('inventory_levels', {
        tenant_id: tenantId,
        variant_id: row.id,
        quantity_available: configured,
        quantity_reserved: 0,
      });
    }
  } catch (err) {
    console.error(
      '[catalog-write] inventory row creation FAILED — affected variants cannot be sold ' +
        '(decrementInventory fails closed on a missing row)',
      (err as Error)?.message || err,
    );
  }
}

/** draft / live / archived — the constrained column, derived from the flags. */
function statusFromFlags(product: Record<string, unknown>): 'draft' | 'live' | 'archived' {
  if (product.isArchived === true) return 'archived';
  if (product.isActive === true) return 'live';
  return 'draft';
}

/**
 * LOWERCASE, matching the database. 00012 established
 * ('fcfs','raffle','waitlist') on product_variants and 00020 aligned products
 * to it. Writing 'RAFFLE' violates the CHECK constraint (23514) — which a fake
 * PostgREST will not catch, because fixtures do not enforce constraints.
 */
function normalizeMode(value: unknown): 'fcfs' | 'raffle' | 'waitlist' {
  const v = String(value || '').toLowerCase();
  if (v === 'fcfs') return 'fcfs';
  if (v === 'waitlist') return 'waitlist';
  return 'raffle';
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
        media_gallery: warnOnBase64Media(buildMediaGallery(product), product),
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

    // unique (product_id, option_label) means same-label categories upsert
    // onto each other. Count DISTINCT labels, and report the collisions --
    // counting loop iterations would over-report the rows that survive.
    const labelCounts = new Map<string, number>();
    for (const raw of cats) {
      const size = String(((raw || {}) as Record<string, unknown>).size || '').trim();
      if (size) labelCounts.set(size, (labelCounts.get(size) || 0) + 1);
    }
    const duplicateLabels = [...labelCounts.entries()]
      .filter(([, n]) => n > 1)
      .map(([label, count]) => ({ label, count }));

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
    }

    // INVENTORY ROWS (H4, defect A). catalog-write created products and
    // variants but never inventory_levels, and decrementInventory fails CLOSED
    // on no_inventory_row -- so a newly created product could not be bought at
    // all, and the H4 backfill would have decayed the moment anyone added one.
    //
    // CREATE-IF-MISSING, NEVER OVERWRITE. quantity_available is live stock,
    // not configuration: rewriting it from the configured total on every save
    // would resurrect already-sold units. Where the two disagree we say so
    // rather than silently picking one.
    await writeInventoryRows(tenantId, productId, product);

    return {
      ok: true,
      productId,
      variantCount: labelCounts.size,
      ...(duplicateLabels.length > 0 ? { duplicateLabels } : {}),
    };
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
