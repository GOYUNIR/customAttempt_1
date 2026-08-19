import { NextResponse } from 'next/server';
import {
  aggregateLiveInventoryByProduct,
  createRedisClient,
  findLiveInventoryForProduct,
  listLiveStates,
  loadStoreConfigCached,
  safeParseRedisItem,
  PRODUCTS_KEY,
  OVERRIDES_KEY,
  OVERRIDE_SCHEDULE_FIELD,
  OVERRIDE_SOCIAL_PROOF_FIELD,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { mergeOrbsConfig, isLegacyHeroContent, resolveNextRaffleAnchorMs, normalizeCategories, normalizeSizeConfigs, resolveSizeNextAnchorMs, sizeConfigKey, resolveSizeReleaseEndsAt } from '@/lib/storefront-config';
import { normalizeSamplerSizes } from '@/lib/sampler-config';
import { dropTimestampToMs, formatStoreWallClock } from '@/lib/drop-timestamps';
import { withTtlCache } from '@/lib/ttl-cache';
import { brandLogoRef, publicMediaRef } from '@/lib/media';
import { edgeCacheHeaders } from '@/lib/cache-headers';

export const dynamic = 'force-dynamic';

type PublicPriceCategory = {
  size: string;
  price: number;
  /** Per-size checkout mode ('RAFFLE' | 'FCFS'); a product can mix formats. */
  checkoutMode?: 'RAFFLE' | 'FCFS';
};

type PublicStoreProduct = {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  sortOrder: number;
  productType: string;
  checkoutMode: 'RAFFLE' | 'FCFS';
  maxPerEmail: number;
  maxPerCart: number;
  isActive: boolean;
  isArchived: boolean;
  isUpcoming: boolean;
  notes: { label: string; name: string; text: string }[];
  images: string[];
  /** Per-media crop records (parallel to `images`) for the gallery framing. */
  crops?: Array<{ x: number; y: number; w: number; h: number }>;
  priceCategories: PublicPriceCategory[];
  /** Category tags from the admin-managed list (Settings → Catalog). */
  categories?: string[];
  totalInventory?: number;
  inventoryRemaining?: number;
  soldOut?: boolean;
  goLiveAt?: string;
  releaseEndsAt?: string;
  /** Per-product recurring raffle cadence (admin → Product → Raffle schedule). */
  customDropSchedule?: Record<string, any>;
  /**
   * Effective countdown end the storefront should display. Equals
   * `releaseEndsAt` while the current raffle round is still counting down, and
   * rolls forward to the NEXT scheduled draw moment once a recurring raffle's
   * timer has passed but inventory remains — so the UI shows the new timer
   * instead of "Until sold out". Empty for sold-out / one-shot-ended products.
   */
  nextReleaseEndsAt?: string;
  /**
   * Per-size countdown anchors — keyed by normalized size label, same shape as
   * `releaseEndsAt` but resolved for EACH size independently (per-size raffle
   * configs). The product page uses the entry for the SELECTED size.
   */
  sizeNextReleaseEndsAt?: Record<string, string>;
  /**
   * Per-size raffle configs (own countdown end / own recurring schedule per
   * size). Passed through sanitized so the product page can show the right
   * timer per size without a second round-trip.
   */
  sizeConfigs?: Record<string, { releaseEndsAt?: string; customDropSchedule?: Record<string, any> }>;
  /** Per-product customer-facing copy overrides (empty = inherit the global
   *  Settings → Storefront copy, which in turn falls back to the built-in). */
  urgencyInStock?: string;
  urgencySoldOut?: string;
  statusLive?: string;
  statusArchived?: string;
  /** Mixed-format ribbon template ({raffle}/{fcfs} count tokens). Empty =
   *  inherit the global Settings → Storefront copy (then the built-in line). */
  mixedFormatRibbon?: string;
  /** Per-product show/hide toggles (default true — absent means show). */
  showUrgencyLine?: boolean;
  showStatusLine?: boolean;
  showNotesSection?: boolean;
  showMixedRibbon?: boolean;
  soldOutBehavior?: string;
  soldOutArchiveDelayHours?: number;
  soldOutAt?: string;
  deliveryIncentiveEnabled?: boolean;
  deliveryIncentiveTriggerSizes?: string[];
  deliveryIncentiveCreditCents?: number;
  /** Per-size trial-SKU records — the storefront uses these for badges + per-size copy. */
  samplerSizes?: Array<{
    size: string;
    label?: string;
    fullSize?: string;
    creditCents?: number | null;
    minOrderSubtotalCents?: number | null;
    neverExpires?: boolean | null;
    expiresDays?: number | null;
    codePrefix?: string | null;
    note?: string | null;
  }>;
};

function toMs(value: unknown, timezone?: string): number | null {
  const parsed = dropTimestampToMs(value, timezone);
  return parsed === null ? null : parsed;
}

function normalizeCheckoutMode(product: any): 'RAFFLE' | 'FCFS' {
  const mode = String(product?.checkoutMode || '').toUpperCase();
  if (mode === 'FCFS') return 'FCFS';
  if (mode === 'RAFFLE') return 'RAFFLE';
  if (product?.isRaffle === false || String(product?.productType || '').toLowerCase() === 'checkout') return 'FCFS';
  return 'RAFFLE';
}

function sanitizeProduct(raw: any): PublicStoreProduct {
  const checkoutMode = normalizeCheckoutMode(raw);
  const priceCats = Array.isArray(raw?.priceCategories) ? raw.priceCategories : [];
  const id = String(raw?.id || '');
  return {
    id,
    name: String(raw?.name || ''),
    slug: String(raw?.slug || ''),
    prefix: String(raw?.prefix || ''),
    tagline: String(raw?.tagline || ''),
    desc: String(raw?.desc || ''),
    sortOrder: Number(raw?.sortOrder || 0),
    productType: checkoutMode === 'FCFS' ? 'fcfs' : 'raffle',
    checkoutMode,
    maxPerEmail: Math.max(1, Number(raw?.maxPerEmail || 1)),
    maxPerCart: Math.max(1, Number(raw?.maxPerCart || raw?.maxPerEmail || 1)),
    // Explicit publish flag: only true when set. Missing/false stays unpublished.
    isActive: raw?.isActive === true || raw?.isActive === 'true',
    isArchived: raw?.isArchived === true || raw?.isArchived === 'true',
    isUpcoming: raw?.isUpcoming === true || raw?.isUpcoming === 'true',
    notes: Array.isArray(raw?.notes) ? raw.notes : [],
    // Base64 data-URL media is replaced with immutable /media/... refs so the
    // payload stays small (the app/media route streams the bytes from Redis
    // and Vercel's edge cache serves them). URLs / relative paths pass through.
    images: Array.isArray(raw?.images) ? raw.images.map((image: unknown, index: number) => publicMediaRef(image, id, index)).filter(Boolean) : [],
    // Per-media crop records (parallel to images). Kept so the product-page
    // gallery can apply the exact framing the operator chose in admin.
    crops: Array.isArray(raw?.crops) ? raw.crops : undefined,
    priceCategories: priceCats.map((category: any) => ({
      size: String(category?.size || 'Standard'),
      price: Math.max(0, Number(category?.price || 0)),
      // Per-size checkout mode (RAFFLE vs FCFS) — a product can mix formats
      // (e.g. a sampler size sells instantly while the full size runs a raffle).
      checkoutMode: (() => {
        const mode = String(category?.checkoutMode || '').toUpperCase();
        if (mode === 'RAFFLE' || mode === 'FCFS') return mode;
        return undefined;
      })(),
    })),
    // Category tags from the admin-managed list (Settings → Catalog).
    categories: Array.isArray(raw?.categories) ? raw.categories.map(String) : [],
    totalInventory: Math.max(0, Number(raw?.totalInventory || 0)),
    inventoryRemaining: undefined,
    soldOut: false,
    goLiveAt: String(raw?.goLiveAt || ''),
    releaseEndsAt: String(raw?.releaseEndsAt || ''),
    customDropSchedule: raw?.customDropSchedule && typeof raw.customDropSchedule === 'object'
      ? raw.customDropSchedule
      : undefined,
    soldOutBehavior: String(raw?.soldOutBehavior || 'stay_visible'),
    soldOutArchiveDelayHours: Math.max(0, Number(raw?.soldOutArchiveDelayHours || 0)),
    soldOutAt: String(raw?.soldOutAt || ''),
    // Per-product customer-facing copy overrides (empty = inherit the global
    // Settings → Storefront copy, which in turn falls back to the built-in).
    urgencyInStock: typeof raw?.urgencyInStock === 'string' ? raw.urgencyInStock : '',
    urgencySoldOut: typeof raw?.urgencySoldOut === 'string' ? raw.urgencySoldOut : '',
    statusLive: typeof raw?.statusLive === 'string' ? raw.statusLive : '',
    statusArchived: typeof raw?.statusArchived === 'string' ? raw.statusArchived : '',
    // Mixed-format ribbon template ({raffle}/{fcfs} count tokens). Empty =
    // inherit the global Settings → Storefront copy (then the built-in line).
    mixedFormatRibbon: typeof raw?.mixedFormatRibbon === 'string' ? raw.mixedFormatRibbon : '',
    // Per-product show/hide toggles for the customer-facing blocks. An absent
    // value (legacy product) means "show" — the storefront treats `!== false`
    // as enabled so old records render exactly as before.
    showUrgencyLine: raw?.showUrgencyLine !== false,
    showStatusLine: raw?.showStatusLine !== false,
    showNotesSection: raw?.showNotesSection !== false,
    showMixedRibbon: raw?.showMixedRibbon !== false,
    // Per-size raffle configs — sanitized so a malformed/deleted-size entry can
    // never leak into the public payload or confuse the storefront countdown.
    sizeConfigs: normalizeSizeConfigs(raw?.sizeConfigs, Array.isArray(raw?.priceCategories) ? raw.priceCategories : []),
    deliveryIncentiveEnabled: raw?.deliveryIncentiveEnabled === true,
    deliveryIncentiveTriggerSizes: Array.isArray(raw?.deliveryIncentiveTriggerSizes) ? raw.deliveryIncentiveTriggerSizes.map(String) : [],
    deliveryIncentiveCreditCents: Math.max(0, Number(raw?.deliveryIncentiveCreditCents || 0)),
    samplerSizes: normalizeSamplerSizes(raw?.samplerSizes, Array.isArray(raw?.priceCategories) ? raw.priceCategories : []),
  };
}

function mergePublicConfig(redisConfig: Record<string, any> = {}) {
  const defaults = GOYUNIR_STORE_SUITE as any;
  return {
    ...defaults,
    ...redisConfig,
    themeColors: { ...(defaults.themeColors || {}), ...(redisConfig.themeColors || {}) },
    availableSizes:
      Array.isArray(redisConfig.availableSizes) && redisConfig.availableSizes.length > 0
        ? redisConfig.availableSizes
        : defaults.availableSizes || ['Standard'],
    dropSchedule: { ...(defaults.dropSchedule || {}), ...(redisConfig.dropSchedule || {}) },
    animationMechanics: { ...(defaults.animationMechanics || {}), ...(redisConfig.animationMechanics || {}) },
    raffleRegistrationForm: { ...(defaults.raffleRegistrationForm || {}), ...(redisConfig.raffleRegistrationForm || {}) },
    // Legacy heroContent (written before the story fields existed) was never
    // displayed on the home page — fall back to the current defaults.
    heroContent: isLegacyHeroContent(redisConfig.heroContent)
      ? { ...(defaults.heroContent || {}) }
      : { ...(defaults.heroContent || {}), ...(redisConfig.heroContent || {}) },
    socialProof: { ...(defaults.socialProof || {}), ...(redisConfig.socialProof || {}) },
    brandFooterData: { ...(defaults.brandFooterData || {}), ...(redisConfig.brandFooterData || {}) },
    catalogPreview: {
      upcomingDrops: Array.isArray(redisConfig?.catalogPreview?.upcomingDrops)
        ? redisConfig.catalogPreview.upcomingDrops
        : defaults.catalogPreview?.upcomingDrops || [],
      archiveScents: Array.isArray(redisConfig?.catalogPreview?.archiveScents)
        ? redisConfig.catalogPreview.archiveScents
        : defaults.catalogPreview?.archiveScents || [],
    },
    catalog: {
      sectionOrder:
        Array.isArray(redisConfig?.catalog?.sectionOrder) && redisConfig.catalog.sectionOrder.length > 0
          ? redisConfig.catalog.sectionOrder
          : defaults.catalog?.sectionOrder || ['upcoming', 'archive', 'live'],
      categories: normalizeCategories(redisConfig?.catalog?.categories ?? defaults.catalog?.categories),
    },
    checkout: {
      requireAddressAutofill: redisConfig?.checkout?.requireAddressAutofill !== false,
    },
    branding: {
      ...(defaults.branding || {}),
      ...(redisConfig.branding || {}),
      // The logo is stored as a base64 data URL in Redis — serve it through
      // /media/logo (edge-cached, immutable) instead of shipping the raw bytes
      // in every store payload and every SSR HTML page.
      logoUrl: brandLogoRef((redisConfig.branding || {}).logoUrl ?? (defaults.branding || {}).logoUrl),
    },
    rewards: { ...(defaults.rewards || {}), ...(redisConfig.rewards || {}) },
    gallery: { ...(defaults.gallery || {}), ...(redisConfig.gallery || {}) },
    legal: { ...(defaults.legal || {}), ...(redisConfig.legal || {}) },
    orbs: mergeOrbsConfig(redisConfig?.orbs || (defaults as any).orbs),
    behavior: {
      // Start-at-top is the template default; an explicit false disables it.
      scrollToTopOnLoad: redisConfig?.behavior?.scrollToTopOnLoad !== false,
    },
  };
}

function applyLifecycle(
  products: PublicStoreProduct[],
  liveStates: Awaited<ReturnType<typeof listLiveStates>>,
  timezone?: string,
  globalSchedule?: Record<string, any>,
) {
  const liveStatesByProduct = aggregateLiveInventoryByProduct(liveStates);
  const now = Date.now();

  return products.map((item) => {
    const inventory = findLiveInventoryForProduct(liveStatesByProduct, item, liveStates);
    const inventoryRemaining = inventory
      ? inventory.inventoryRemaining
      : Math.max(0, Number(item.totalInventory || 0));
    const totalInventory = inventory
      ? inventory.totalInventory
      : Math.max(0, Number(item.totalInventory || 0));
    // Sold out when (a) inventory was configured and remaining hit zero, or
    // (b) no inventory is configured but the operator chose "stay visible as
    // social proof" — a 0-stock active product is shown as sold out on purpose
    // so it never looks like an available drop with nothing to sell.
    const soldOut =
      totalInventory > 0
        ? inventoryRemaining <= 0
        : item.soldOutBehavior === 'stay_visible';
    const goLiveAtMs = toMs(item.goLiveAt, timezone);
    const soldOutAtMs = toMs(item.soldOutAt, timezone);
    const shouldGoLive = item.isUpcoming && goLiveAtMs !== null && now >= goLiveAtMs;
    const shouldArchiveFromSoldOut = soldOut && item.soldOutBehavior === 'archive_now';
    const shouldArchiveAfterDelay =
      soldOut &&
      item.soldOutBehavior === 'archive_after_delay' &&
      soldOutAtMs !== null &&
      now >= soldOutAtMs + Math.max(0, Number(item.soldOutArchiveDelayHours || 0)) * 60 * 60 * 1000;

    const lifecycleProduct = {
      ...item,
      inventoryRemaining,
      totalInventory,
      soldOut,
      isUpcoming: shouldGoLive ? false : item.isUpcoming,
      isArchived: shouldArchiveFromSoldOut || shouldArchiveAfterDelay ? true : item.isArchived,
      isActive: shouldGoLive ? true : item.isActive,
    };

    // Effective countdown anchor: the product's own releaseEndsAt while it is
    // still in the future; otherwise (inventory remains + recurring schedule)
    // the NEXT scheduled draw moment — the "new raffle" timer the storefront
    // should show instead of "Until sold out". Sold-out / one-shot-ended
    // products keep the (past) raw value so the UI can label them closed.
    //
    // Per-size raffle configs make this per-size: each size resolves ITS OWN
    // anchor (own releaseEndsAt + own schedule win over product → global). The
    // product-level anchor is the EARLIEST per-size anchor so home/catalog
    // cards show the soonest upcoming draw across all raffle sizes.
    let nextReleaseEndsAt = String(item.releaseEndsAt || '');
    const sizeNextReleaseEndsAt: Record<string, string> = {};
    try {
      const sizeAnchors: Array<{ key: string; ms: number }> = [];
      const cats = Array.isArray(item.priceCategories) ? item.priceCategories : [];
      for (const cat of cats) {
        const size = String(cat?.size || '').trim();
        if (!size) continue;
        const key = sizeConfigKey(size);
        let anchorMs: number | null = null;
        try {
          anchorMs = resolveSizeNextAnchorMs(item, size, globalSchedule || {}, now);
        } catch {
          anchorMs = null;
        }
        const rawEnd = resolveSizeReleaseEndsAt(item, size);
        if (anchorMs !== null) {
          const formatted = formatStoreWallClock(anchorMs, timezone);
          if (formatted) {
            sizeNextReleaseEndsAt[key] = formatted;
            sizeAnchors.push({ key, ms: anchorMs });
          }
        } else if (rawEnd) {
          sizeNextReleaseEndsAt[key] = rawEnd;
        }
      }
      if (sizeAnchors.length > 0) {
        const earliest = sizeAnchors.reduce((a, b) => (b.ms < a.ms ? b : a));
        nextReleaseEndsAt = sizeNextReleaseEndsAt[earliest.key] || nextReleaseEndsAt;
      } else {
        const effectiveSchedule = {
          ...GOYUNIR_STORE_SUITE.dropSchedule,
          ...(globalSchedule || {}),
          ...((item as any).customDropSchedule || {}),
        };
        const nextAnchorMs = resolveNextRaffleAnchorMs(lifecycleProduct as any, effectiveSchedule as any, now);
        if (nextAnchorMs !== null) nextReleaseEndsAt = formatStoreWallClock(nextAnchorMs, timezone);
      }
    } catch {
      /* a schedule glitch must never break the store payload */
    }

    return { ...lifecycleProduct, nextReleaseEndsAt, sizeNextReleaseEndsAt };
  });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedSlug = String(url.searchParams.get('slug') || '').trim();

    const payload = await withTtlCache(`store:${requestedSlug || '*'}:v2`, 10_000, () => buildStorePayload(requestedSlug));
    // Edge-cache the (now small) payload: Vercel's CDN serves it instead of
    // streaming it from the origin on every request — the single biggest Fast
    // Origin Transfer saving. Fresh within the documented ~10s window (same as
    // the server-side TTL cache). No max-age, so browsers always revalidate.
    return NextResponse.json(payload, {
      headers: edgeCacheHeaders('public, s-maxage=10, stale-while-revalidate=30'),
    });
  } catch (err: any) {
    console.error('[store] failed', err?.message || err);
    return NextResponse.json({ error: 'Store unavailable. Please try again.' }, { status: 500 });
  }
}

async function buildStorePayload(requestedSlug: string) {
  const redis = createRedisClient();
  const sortProducts = (items: PublicStoreProduct[]) =>
    [...items].sort(
      (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)),
    );

  if (!redis) {
    // No Redis configured and nothing has been seeded yet → start with zero
    // products. Operators publish content via /admin (Seed Defaults or Add Product).
    return {
      config: mergePublicConfig({}),
      activeProducts: [],
      archivedProducts: [],
      upcomingProducts: [],
      allProducts: [],
      product: null,
      scheduleOverride: {},
      socialOverride: {},
      timestamp: Date.now(),
      fromFallback: true,
    };
  }

  const config = mergePublicConfig(await loadStoreConfigCached(redis));
  const liveStates = await listLiveStates(redis);

  // Global drop-schedule override (admin → Automation → Save Schedule) merged
  // over the seeded store config + static code default. Priority is override >
  // store config > static, so the storefront's next-raffle anchor agrees with
  // the draw engine.
  const scheduleRaw = await redis.hget(OVERRIDES_KEY, OVERRIDE_SCHEDULE_FIELD);
  const scheduleOverride = safeParseRedisItem<any>(scheduleRaw) || {};
  const globalSchedule = {
    ...GOYUNIR_STORE_SUITE.dropSchedule,
    ...(config?.dropSchedule || {}),
    ...scheduleOverride,
  };

  let allProducts: PublicStoreProduct[] = [];
  const allRaw = await redis.hgetall(PRODUCTS_KEY);
  if (allRaw) {
    for (const value of Object.values(allRaw)) {
      const p = safeParseRedisItem<any>(value);
      if (p) allProducts.push(sanitizeProduct(p));
    }
  }

  allProducts = sortProducts(allProducts);
  const storeTimezone = String(config?.dropSchedule?.timezone || GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles');
  const lifecycleProducts = applyLifecycle(allProducts, liveStates, storeTimezone, globalSchedule);
  const activeProducts = lifecycleProducts.filter((item) => item.isActive && !item.isArchived && !item.isUpcoming);
  const archivedProducts = lifecycleProducts.filter((item) => item.isArchived);
  const upcomingProducts = lifecycleProducts.filter((item) => item.isUpcoming && !item.isArchived);

  const product = requestedSlug
    ? lifecycleProducts.find((item) => item.slug === requestedSlug) || null
    : null;

  const socialRaw = await redis.hget(OVERRIDES_KEY, OVERRIDE_SOCIAL_PROOF_FIELD);
  const socialOverride = safeParseRedisItem<any>(socialRaw) || {};

  return {
    config,
    activeProducts,
    archivedProducts,
    upcomingProducts,
    allProducts: lifecycleProducts,
    product,
    scheduleOverride,
    socialOverride,
    timestamp: Date.now(),
  };
}
