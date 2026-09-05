import { NextResponse } from 'next/server';
import {
  createRedisClient,
  loadProducts,
  defaultStripePriceId,
  PRODUCTS_KEY,
  STORE_CONFIG_KEY,
  safeParseRedisItem,
  unarchiveProductFromCatalog,
  LIVE_STATE_KEY,
  POOL_STATS_KEY,
  poolStatField,
  LAST_AUTO_DRAW_HASH_KEY,
  lastAutoDrawField,
  OVERRIDES_KEY,
  productOverrideField,
  poolKey,
  intentPoolKey,
  waitlistPoolKey,
  emailBlockKey,
  cardBlockKey,
} from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { resolveDefaultStripePriceId } from '@/services/config/platform-settings';
import { UNCONFIGURED_PRICE_SENTINEL, normalizeCategories, normalizeSizeConfigs, getSizeCheckoutMode } from '@/lib/storefront-config';
import { normalizeSamplerSizes } from '@/lib/sampler-config';
import { checkProductSanity, sortSanityIssues } from '@/lib/product-sanity';
import { appendAudit } from '@/app/api/admin/audit/route';
import { normalizeProductStatus, statusFromLegacy, legacyBooleansFromStatus } from '@/lib/product-status';
import { validatePriceCategories } from '@/lib/price-validation';
import { bindInventoryPoolToCategories } from '@/lib/inventory-pool';
import { queryProducts } from '@/lib/product-query';

export const dynamic = 'force-dynamic';

function toBool(value: any, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

async function syncCatalogConfigForProduct(
  redis: any,
  product: any,
  options?: { previousSlug?: string; previousName?: string },
) {
  // Catalog groupings live in store:config.catalogPreview (single source of
  // truth). Read-modify-write so manual admin entries are preserved.
  const raw = await redis.get(STORE_CONFIG_KEY);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  const preview = parsed?.catalogPreview || {};
  const upcomingDrops = Array.isArray(preview.upcomingDrops) ? preview.upcomingDrops : [];
  const archiveScents = Array.isArray(preview.archiveScents) ? preview.archiveScents : [];

  const upcomingEntry = {
    id: product.id,
    name: product.name,
    status: 'Upcoming',
    eta: product.tagline || 'Coming soon',
    image: product.images?.[0] || `/images/${product.prefix}/1.jpeg`,
    description: product.desc || '',
    slug: product.slug,
  };
  const archiveEntry = {
    id: product.id,
    name: product.name,
    status: 'Archived',
    image: product.images?.[0] || `/images/${product.prefix}/1.jpeg`,
    description: product.desc || '',
    slug: product.slug,
  };

  const identityKeys = new Set(
    [
      product.slug,
      product.name,
      options?.previousSlug,
      options?.previousName,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );

  const shouldKeep = (entry: any) => {
    const key = String(entry?.slug || entry?.name || '').trim();
    return key ? !identityKeys.has(key) : true;
  };

  const nextUpcoming = upcomingDrops.filter(shouldKeep);
  const nextArchive = archiveScents.filter(shouldKeep);

  if (product.isUpcoming && !product.isArchived) {
    nextUpcoming.push(upcomingEntry);
  }
  if (product.isArchived) {
    nextArchive.push(archiveEntry);
  }

  await redis.set(STORE_CONFIG_KEY, JSON.stringify({ ...parsed, catalogPreview: { upcomingDrops: nextUpcoming, archiveScents: nextArchive } }));
}

async function saveProduct(redis: any, product: any, options?: { previousSlug?: string; previousName?: string }) {
  product.isActive = toBool(product.isActive, false);
  product.isArchived = toBool(product.isArchived, false);
  product.isUpcoming = toBool(product.isUpcoming, false);
  if (product.isArchived) product.isUpcoming = false;
  if (product.isUpcoming) product.isArchived = false;
  // Persist the canonical status enum alongside the legacy booleans so every
  // read path can resolve state from a single field (and the two never drift).
  product.status = statusFromLegacy(product);

  // Products live ONLY in store:products. No mirror hashes to maintain —
  // active/archived/upcoming are derived by filtering at read time.
  await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });

  await syncCatalogConfigForProduct(redis, product, options);
}

async function deleteProduct(redis: any, id: string) {
  const rawProduct = await redis.hget(PRODUCTS_KEY, id);
  // Upstash REST Redis auto-deserializes stored JSON, so `hget` can return an
  // ALREADY-PARSED OBJECT (not a string). Reading it through safeParseRedisItem
  // (which accepts both) guarantees the catalog-preview cleanup below actually
  // runs — before this fix the `typeof rawProduct === 'string'` guard skipped
  // it on the default provider and a deleted product kept rendering in the
  // catalog's Upcoming/Past Archives sections forever.
  const deletedProduct = safeParseRedisItem<any>(rawProduct);
  await redis.hdel(PRODUCTS_KEY, id);

  try {
    // Remove EVERY trace so the product can never keep rendering AND its
    // operational state never lingers:
    // 1) its auto-created catalogPreview entries (store:config.upcomingDrops /
    //    archiveScents) are pruned by identity; 2) its ops:catalog_archive
    //    record is dropped; 3) its live inventory states are dropped (fields
    //    are `<productId>-<slug>:<size>`, so every field starting with the id
    //    must go — the old `hdel(LIVE_STATE_KEY, id)` matched nothing).
    if (deletedProduct) {
      await syncCatalogConfigForProduct(redis, { ...deletedProduct, isUpcoming: false, isArchived: false });

      // Per-product name/size records: pools, intent/waitlist pools, fraud
      // blocks, entry counters and last-auto timestamps.
      const name = String(deletedProduct.name || '').trim();
      const sizes = Array.isArray(deletedProduct.priceCategories)
        ? deletedProduct.priceCategories.map((c: any) => String(c?.size || '').trim()).filter(Boolean)
        : [];
      const keysToDelete: string[] = [];
      const statsFields: string[] = [];
      const lastAutoFields: string[] = [];
      for (const size of sizes) {
        if (!name || !size) continue;
        keysToDelete.push(
          poolKey(name, size),
          intentPoolKey(name, size),
          waitlistPoolKey(name, size),
          emailBlockKey(name, size),
          cardBlockKey(name, size),
        );
        statsFields.push(poolStatField('sub', name, size), poolStatField('int', name, size));
        lastAutoFields.push(lastAutoDrawField(name, size));
      }
      if (keysToDelete.length > 0) await redis.del(...keysToDelete);
      if (statsFields.length > 0) await redis.hdel(POOL_STATS_KEY, ...statsFields);
      if (lastAutoFields.length > 0) await redis.hdel(LAST_AUTO_DRAW_HASH_KEY, ...lastAutoFields);
      await redis.hdel(OVERRIDES_KEY, productOverrideField(id));
    }
    await unarchiveProductFromCatalog(redis, id);
    // Drop every live-state field that belongs to this product
    // (`<productId>-<slug>:<size>` — the plain id is never a field name).
    try {
      const liveRaw = (await redis.hgetall(LIVE_STATE_KEY)) || {};
      const liveDeletes = Object.keys(liveRaw).filter((field) => field.startsWith(`${id}-`));
      if (liveDeletes.length > 0) await redis.hdel(LIVE_STATE_KEY, ...liveDeletes);
    } catch {}
    await redis.hdel(LIVE_STATE_KEY, id);
  } catch (err) {
    console.error('[products] Delete cleanup failed for', id, err);
  }
}

export async function GET(request: Request) {
  if (!(await adminAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const url = new URL(request.url);
  const includeArchived = url.searchParams.get('includeArchived') === 'true';
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ products: [] });
  const all = await loadProducts(redis);
  let products = Object.values(all);
  if (!includeArchived) {
    products = products.filter((p: any) => !p.isArchived && !p.isUpcoming);
  }

  // ── High-volume mode (opt-in): when `page` is present, run server-side
  //    pagination + instant fuzzy search + faceted filters so a 10k+ SKU
  //    catalog is never shipped whole to the admin browser.
  const resolvedDefault = await resolveDefaultStripePriceId().catch(() => '');
  const pageParam = url.searchParams.get('page');

  if (pageParam !== null) {
    const result = queryProducts(products, {
      search: url.searchParams.get('search') || '',
      status: url.searchParams.get('status') || '',
      category: url.searchParams.get('category') || '',
      checkoutMode: url.searchParams.get('checkoutMode') || '',
      hasInventoryPool: url.searchParams.get('hasInventoryPool') || undefined,
      page: Number(pageParam) || 1,
      pageSize: Number(url.searchParams.get('pageSize')) || 25,
    });
    return NextResponse.json({
      products: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      defaultStripePriceId: resolvedDefault || defaultStripePriceId(),
    });
  }

  return NextResponse.json({ products, defaultStripePriceId: resolvedDefault || defaultStripePriceId() });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = body.password || '';
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const action = body.action || 'upsert';
  const allProducts = await loadProducts(redis);

  if (action === 'delete') {
    await deleteProduct(redis, body.id);
    try {
      await appendAudit(redis, { action: 'PRODUCT_DELETED', detail: `Product ${body.id}`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true });
  }
  if (action === 'archive') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isArchived = true;
    product.isUpcoming = false;
    // DO NOT change isActive – archiving should not hide the product
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    try {
      await appendAudit(redis, { action: 'PRODUCT_ARCHIVED', detail: `${product.name} (${product.id})`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, product });
  }
  if (action === 'unarchive') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isArchived = false;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    try {
      await appendAudit(redis, { action: 'PRODUCT_UNARCHIVED', detail: `${product.name} (${product.id})`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, product });
  }
  if (action === 'toggleActive') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isActive = typeof body.nextActive === 'boolean' ? body.nextActive : !Boolean(product.isActive);
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    try {
      await appendAudit(redis, { action: 'PRODUCT_VISIBILITY_CHANGED', detail: `${product.name} → ${product.isActive ? 'visible' : 'hidden'}`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, product });
  }
  if (action === 'addToUpcoming') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isUpcoming = true;
    product.isArchived = false;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    try {
      await appendAudit(redis, { action: 'PRODUCT_UPCOMING_CHANGED', detail: `${product.name} → upcoming`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, product });
  }
  if (action === 'removeFromUpcoming') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.isUpcoming = false;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    try {
      await appendAudit(redis, { action: 'PRODUCT_UPCOMING_CHANGED', detail: `${product.name} → not upcoming`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, product });
  }
  if (action === 'reorder') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    product.sortOrder = Number(body.sortOrder) || 0;
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    try {
      await appendAudit(redis, { action: 'PRODUCT_REORDERED', detail: `${product.name} → sort order ${product.sortOrder}`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, product });
  }
  if (action === 'setStatus') {
    const product = allProducts[body.id];
    if (!product) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const status = normalizeProductStatus(body.status, statusFromLegacy(product));
    // “Go live at” is optional: Upcoming may be saved without a date (the
    // release stays queued until an operator sets one, and auto-activates when
    // the clock reaches it). No date → no auto-publish, which is allowed.
    const booleans = legacyBooleansFromStatus(status);
    product.status = status;
    product.isActive = booleans.isActive;
    product.isArchived = booleans.isArchived;
    product.isUpcoming = booleans.isUpcoming;
    if (status === 'UPCOMING' && body.goLiveAt) product.goLiveAt = String(body.goLiveAt);
    product.updatedAt = new Date().toISOString();
    await saveProduct(redis, product);
    try {
      await appendAudit(redis, { action: 'PRODUCT_STATUS_CHANGED', detail: `${product.name} → ${status}`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, product });
  }

  // Upsert (create or update)
  const id = body.id || `prod_${Date.now().toString(36)}`;
  const existing = allProducts[id] || null;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const numberOr = (value: any, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const name = body.name?.trim() || existing?.name || '';
  if (!name) return NextResponse.json({ error: 'Name required' }, { status: 400 });
  const slugSource = has('slug') ? String(body.slug || '').trim() : String(existing?.slug || '');
  const slug = slugSource || name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

  const product = {
    id,
    name,
    slug,
    prefix: has('prefix') ? String(body.prefix || '') : (existing?.prefix || ''),
    tagline: has('tagline') ? String(body.tagline || '') : (existing?.tagline || ''),
    desc: has('desc') ? String(body.desc || '') : (existing?.desc || ''),
    priceCategories: (() => {
      const cats = Array.isArray(body.priceCategories)
        ? body.priceCategories
        : (existing?.priceCategories || [{ size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId(), winnerTiers: '0' }]);
      // Per-size checkout mode ('RAFFLE' | 'FCFS' | empty = follow product).
      // A product can mix formats — FCFS sizes sell instantly, RAFFLE sizes draw.
      // Per-item limits (maxPerEmail / maxPerCart / maxRaffleAllocationLimit) are
      // also sanitized here so a size carries its OWN purchase caps.
      return cats.map((c: any) => {
        const mode = String(c?.checkoutMode || '').toUpperCase();
        const out = { ...(c || {}) };
        if (mode !== 'RAFFLE' && mode !== 'FCFS') delete out.checkoutMode;
        else out.checkoutMode = mode;
        // Normalize per-item limits: keep only finite, in-range numbers; drop
        // otherwise so the product-level fallback takes over.
        const maxPerEmail = Number(out.maxPerEmail);
        if (Number.isFinite(maxPerEmail) && maxPerEmail >= 1) out.maxPerEmail = Math.floor(maxPerEmail);
        else delete out.maxPerEmail;
        const maxPerCart = Number(out.maxPerCart);
        if (Number.isFinite(maxPerCart) && maxPerCart >= 1) out.maxPerCart = Math.floor(maxPerCart);
        else delete out.maxPerCart;
        const maxRaffleAllocationLimit = Number(out.maxRaffleAllocationLimit);
        if (Number.isFinite(maxRaffleAllocationLimit) && maxRaffleAllocationLimit >= 0) out.maxRaffleAllocationLimit = Math.floor(maxRaffleAllocationLimit);
        else delete out.maxRaffleAllocationLimit;
        return out;
      });
    })(),
    isActive: body.isActive !== undefined ? toBool(body.isActive, existing?.isActive ?? false) : (existing?.isActive ?? false),
    isArchived: body.isArchived !== undefined ? toBool(body.isArchived, existing?.isArchived ?? false) : (existing?.isArchived ?? false),
    isUpcoming: body.isUpcoming !== undefined ? toBool(body.isUpcoming, existing?.isUpcoming ?? false) : (existing?.isUpcoming ?? false),
    isRaffle: body.isRaffle !== undefined ? toBool(body.isRaffle, existing?.isRaffle ?? true) : (existing?.isRaffle ?? true),
    checkoutMode: (() => {
      const raw = has('checkoutMode') ? String(body.checkoutMode || '').toUpperCase() : String(existing?.checkoutMode || '').toUpperCase();
      if (raw === 'FCFS') return 'FCFS';
      if (raw === 'RAFFLE') return 'RAFFLE';
      return body.isRaffle === false || existing?.isRaffle === false ? 'FCFS' : 'RAFFLE';
    })(),
    productType: has('productType') ? String(body.productType || '') : (existing?.productType || 'raffle'),
    maxPerEmail: has('maxPerEmail') ? Math.max(1, numberOr(body.maxPerEmail, existing?.maxPerEmail || 1)) : Math.max(1, Number(existing?.maxPerEmail || 1)),
    maxPerCart: has('maxPerCart') ? Math.max(1, numberOr(body.maxPerCart, existing?.maxPerCart || existing?.maxPerEmail || 1)) : Math.max(1, Number(existing?.maxPerCart || existing?.maxPerEmail || 1)),
    sortOrder: has('sortOrder') ? numberOr(body.sortOrder, existing?.sortOrder || 0) : (existing?.sortOrder || 0),
    notes: Array.isArray(body.notes) ? body.notes : (existing?.notes || []),
    images: Array.isArray(body.images) ? body.images : (existing?.images || []),
    // Per-media crop records (parallel to `images`). Stored so the storefront
    // gallery can show the exact framed region the operator chose in admin.
    crops: (() => {
      const images = Array.isArray(body.images) ? body.images : (existing?.images || []);
      if (Array.isArray(body.crops)) return body.crops;
      if (Array.isArray(existing?.crops)) return existing.crops;
      return images.map(() => ({ x: 0.5, y: 0.5, w: 1, h: 1 }));
    })(),
    maxRaffleAllocationLimit: has('maxRaffleAllocationLimit') ? numberOr(body.maxRaffleAllocationLimit, existing?.maxRaffleAllocationLimit || 0) : (existing?.maxRaffleAllocationLimit || 0),
    totalInventory: has('totalInventory') ? numberOr(body.totalInventory, existing?.totalInventory || 0) : (existing?.totalInventory || 0),
    // Per-size stock: a map of `size → units`. When present, live inventory for
    // that size is seeded from this number instead of the product-wide total.
    inventoryPerSize: (() => {
      if (has('inventoryPerSize')) {
        const raw = body.inventoryPerSize && typeof body.inventoryPerSize === 'object' ? body.inventoryPerSize : {};
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw)) {
          const sizeKey = String(k || '').trim();
          const num = Math.max(0, Number(v) || 0);
          if (sizeKey && num > 0) out[sizeKey] = num;
        }
        return out;
      }
      return existing?.inventoryPerSize || {};
    })(),
    // Category tags from the admin-managed list (Settings → Catalog → Categories).
    // Normalized via the shared helper (trim, dedupe, ≤40 chars, first 60).
    categories: has('categories') ? normalizeCategories(body.categories) : (existing?.categories || []),
    winnerTiers: Array.isArray(body.winnerTiers) ? body.winnerTiers : (existing?.winnerTiers || [0]),
    goLiveAt: has('goLiveAt') ? String(body.goLiveAt || '') : (existing?.goLiveAt || ''),
    releaseEndsAt: has('releaseEndsAt') ? String(body.releaseEndsAt || '') : (existing?.releaseEndsAt || ''),
    customDropSchedule: has('customDropSchedule')
      ? (body.customDropSchedule && typeof body.customDropSchedule === 'object' && Object.keys(body.customDropSchedule).length > 0
          ? body.customDropSchedule
          : (existing?.customDropSchedule || null))
      : (existing?.customDropSchedule || null),
    // Per-size raffle configs — "customize each raffle differently". Keyed by
    // normalized size label; a config can carry its own `releaseEndsAt` and/or
    // its own `customDropSchedule`. Normalized so a config for a deleted/renamed
    // size can never survive a save.
    sizeConfigs: (() => {
      const cats = Array.isArray(body.priceCategories)
        ? body.priceCategories
        : (Array.isArray(existing?.priceCategories) ? existing.priceCategories : []);
      if (has('sizeConfigs')) return normalizeSizeConfigs(body.sizeConfigs, cats);
      if (existing?.sizeConfigs) return normalizeSizeConfigs(existing.sizeConfigs, cats);
      return {};
    })(),
    // Per-product customer-facing copy overrides (empty string = inherit the
    // global Settings → Storefront copy, which falls back to the built-in).
    urgencyInStock: has('urgencyInStock') ? String(body.urgencyInStock || '') : (existing?.urgencyInStock || ''),
    urgencySoldOut: has('urgencySoldOut') ? String(body.urgencySoldOut || '') : (existing?.urgencySoldOut || ''),
    statusLive: has('statusLive') ? String(body.statusLive || '') : (existing?.statusLive || ''),
    statusArchived: has('statusArchived') ? String(body.statusArchived || '') : (existing?.statusArchived || ''),
    // Mixed-format ribbon template ({raffle}/{fcfs} tokens). Empty = inherit the
    // global Settings → Storefront copy (which falls back to the built-in line).
    mixedFormatRibbon: has('mixedFormatRibbon') ? String(body.mixedFormatRibbon || '') : (existing?.mixedFormatRibbon || ''),
    // Per-product show/hide toggles for the customer-facing blocks (default ALL
    // on — an absent value on an old product means "show").
    showUrgencyLine: has('showUrgencyLine') ? toBool(body.showUrgencyLine, true) : (existing?.showUrgencyLine ?? true),
    showStatusLine: has('showStatusLine') ? toBool(body.showStatusLine, true) : (existing?.showStatusLine ?? true),
    showNotesSection: has('showNotesSection') ? toBool(body.showNotesSection, true) : (existing?.showNotesSection ?? true),
    showMixedRibbon: has('showMixedRibbon') ? toBool(body.showMixedRibbon, true) : (existing?.showMixedRibbon ?? true),
    soldOutBehavior: has('soldOutBehavior') ? String(body.soldOutBehavior || '') : (existing?.soldOutBehavior || 'stay_visible'),
    soldOutArchiveDelayHours: has('soldOutArchiveDelayHours') ? Math.max(0, numberOr(body.soldOutArchiveDelayHours, existing?.soldOutArchiveDelayHours || 0)) : Math.max(0, Number(existing?.soldOutArchiveDelayHours || 0)),
    soldOutAt: has('soldOutAt') ? String(body.soldOutAt || '') : (existing?.soldOutAt || ''),
    deliveryIncentiveEnabled: has('deliveryIncentiveEnabled') ? toBool(body.deliveryIncentiveEnabled, existing?.deliveryIncentiveEnabled ?? false) : (existing?.deliveryIncentiveEnabled ?? false),
    deliveryIncentiveCreditCents: has('deliveryIncentiveCreditCents') ? Math.max(0, numberOr(body.deliveryIncentiveCreditCents, existing?.deliveryIncentiveCreditCents || 0)) : Math.max(0, Number(existing?.deliveryIncentiveCreditCents || 0)),
    deliveryIncentiveMinOrderSubtotalCents: has('deliveryIncentiveMinOrderSubtotalCents') ? Math.max(0, numberOr(body.deliveryIncentiveMinOrderSubtotalCents, existing?.deliveryIncentiveMinOrderSubtotalCents || 0)) : Math.max(0, Number(existing?.deliveryIncentiveMinOrderSubtotalCents || 0)),
    deliveryIncentiveExpiresDays: has('deliveryIncentiveExpiresDays') ? Math.max(1, numberOr(body.deliveryIncentiveExpiresDays, existing?.deliveryIncentiveExpiresDays || 60)) : Math.max(1, Number(existing?.deliveryIncentiveExpiresDays || 60)),
    // "Never expires" toggle — the generated credit skips the validity window.
    deliveryIncentiveNeverExpires: has('deliveryIncentiveNeverExpires') ? toBool(body.deliveryIncentiveNeverExpires, existing?.deliveryIncentiveNeverExpires ?? false) : (existing?.deliveryIncentiveNeverExpires ?? false),
    deliveryIncentiveCodePrefix: has('deliveryIncentiveCodePrefix') ? String(body.deliveryIncentiveCodePrefix || '') : (existing?.deliveryIncentiveCodePrefix || ''),
    deliveryIncentiveEligibleProductSlugs: Array.isArray(body.deliveryIncentiveEligibleProductSlugs) ? body.deliveryIncentiveEligibleProductSlugs.map(String) : (existing?.deliveryIncentiveEligibleProductSlugs || []),
    deliveryIncentiveEligibleSizes: Array.isArray(body.deliveryIncentiveEligibleSizes) ? body.deliveryIncentiveEligibleSizes.map(String) : (existing?.deliveryIncentiveEligibleSizes || []),
    // Per-size sampler records (trial SKUs). Each entry references a size in
    // `priceCategories` and can override the product-level credit defaults.
    // Normalized through the shared helper so a sampler can never point at a
    // size that doesn't exist on the product.
    samplerSizes: (() => {
      const priceCats = Array.isArray(body.priceCategories)
        ? body.priceCategories
        : (Array.isArray(existing?.priceCategories) ? existing.priceCategories : []);
      if (has('samplerSizes')) return normalizeSamplerSizes(body.samplerSizes, priceCats);
      if (Array.isArray(existing?.samplerSizes)) return normalizeSamplerSizes(existing.samplerSizes, priceCats);
      return [];
    })(),
    // Keep the legacy CSV in sync with the sampler records so older consumers
    // (or a product loaded before this migration) still see the same sizes.
    deliveryIncentiveTriggerSizes: (() => {
      const samplers = normalizeSamplerSizes(
        has('samplerSizes') ? body.samplerSizes : existing?.samplerSizes,
        Array.isArray(body.priceCategories) ? body.priceCategories : (Array.isArray(existing?.priceCategories) ? existing.priceCategories : []),
      );
      if (samplers.length > 0) return samplers.map((s) => s.size);
      if (has('deliveryIncentiveTriggerSizes')) return Array.isArray(body.deliveryIncentiveTriggerSizes) ? body.deliveryIncentiveTriggerSizes.map(String) : (existing?.deliveryIncentiveTriggerSizes || []);
      return Array.isArray(existing?.deliveryIncentiveTriggerSizes) ? existing.deliveryIncentiveTriggerSizes : [];
    })(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // ── Status enum (canonical): an explicit `status` in the request wins; else
  //    derive from the legacy booleans, then project back so the enum and the
  //    three booleans can never disagree.
  const requestedStatus = normalizeProductStatus(
    body.status,
    statusFromLegacy({ status: existing?.status, isActive: product.isActive, isArchived: product.isArchived, isUpcoming: product.isUpcoming }),
  );
  (product as any).status = requestedStatus;
  const legacyStatus = legacyBooleansFromStatus(requestedStatus);
  product.isActive = legacyStatus.isActive;
  product.isArchived = legacyStatus.isArchived;
  product.isUpcoming = legacyStatus.isUpcoming;

  // ── Structural normalization (defense in depth so an invalid config can
  //    NEVER reach production, even if the admin UI misses it):
  //    1. FCFS sizes are never drawn, so any "Winners / draw" on them is
  //       meaningless and stripped (this makes the "winners on FCFS" warning
  //       impossible rather than just flagged).
  //    2. Shared-inventory sync slugs are normalized to URL-safe tokens and
  //       bound to a canonical `inventoryPoolId` (the write-time bind step).
  product.priceCategories = (Array.isArray(product.priceCategories) ? product.priceCategories : []).map((c: any) => {
    const out = { ...(c || {}) };
    if (getSizeCheckoutMode(product, out.size) === 'FCFS') delete out.winnerTiers;
    return out;
  });
  product.priceCategories = bindInventoryPoolToCategories(product.priceCategories);

  // ── Bulletproof price gate: no sentinel / placeholder / zero / sub-cent
  //    prices may ever reach the catalog. A 400 lists every offending size.
  const priceCheck = validatePriceCategories(product.priceCategories);
  if (!priceCheck.ok) {
    return NextResponse.json({
      error: priceCheck.errors[0].error,
      blocking: priceCheck.errors.map((e) => `${e.size}: ${e.error}`),
    }, { status: 400 });
  }

  // ── Smart-math gate: the SAME pure engine the admin editor previews. An
  // exploitable/broken product ('error' severity) can NEVER reach production —
  // the save is refused with a 400 listing every blocking issue so the
  // operator knows exactly what to fix.
  let rewardsCtx: { rewards?: { purchasePointsPerDollar?: number; pointsPerDollar?: number } } = {};
  try {
    const rawConfig = await redis.get(STORE_CONFIG_KEY);
    const cfg = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : (rawConfig || {});
    rewardsCtx = { rewards: cfg?.rewards || undefined };
  } catch { /* rewards context is best-effort */ }
  const sanity = sortSanityIssues(checkProductSanity(product, rewardsCtx));
  const blockers = sanity.filter((i) => i.severity === 'error');
  if (blockers.length > 0) {
    return NextResponse.json({
      error: blockers[0].message,
      blocking: blockers.map((b) => b.message),
    }, { status: 400 });
  }

  await saveProduct(redis, product, {
    previousSlug: existing?.slug,
    previousName: existing?.name,
  });
    try {
      await appendAudit(redis, { action: existing ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED', detail: `${product.name} (${product.id})`, actor: 'admin' });
    } catch {}
  return NextResponse.json({ success: true, product });
}
