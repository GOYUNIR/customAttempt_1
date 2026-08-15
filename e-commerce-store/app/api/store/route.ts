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
import { mergeOrbsConfig, isLegacyHeroContent, resolveNextRaffleAnchorMs } from '@/lib/storefront-config';
import { dropTimestampToMs, formatStoreWallClock } from '@/lib/drop-timestamps';
import { withTtlCache } from '@/lib/ttl-cache';

export const dynamic = 'force-dynamic';

type PublicPriceCategory = {
  size: string;
  price: number;
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
  priceCategories: PublicPriceCategory[];
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
  soldOutBehavior?: string;
  soldOutArchiveDelayHours?: number;
  soldOutAt?: string;
  deliveryIncentiveEnabled?: boolean;
  deliveryIncentiveTriggerSizes?: string[];
  deliveryIncentiveCreditCents?: number;
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
  const categories = Array.isArray(raw?.priceCategories) ? raw.priceCategories : [];
  return {
    id: String(raw?.id || ''),
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
    images: Array.isArray(raw?.images) ? raw.images.filter(Boolean) : [],
    priceCategories: categories.map((category: any) => ({
      size: String(category?.size || 'Standard'),
      price: Math.max(0, Number(category?.price || 0)),
    })),
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
    deliveryIncentiveEnabled: raw?.deliveryIncentiveEnabled === true,
    deliveryIncentiveTriggerSizes: Array.isArray(raw?.deliveryIncentiveTriggerSizes) ? raw.deliveryIncentiveTriggerSizes.map(String) : [],
    deliveryIncentiveCreditCents: Math.max(0, Number(raw?.deliveryIncentiveCreditCents || 0)),
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
    branding: { ...(defaults.branding || {}), ...(redisConfig.branding || {}) },
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
    let nextReleaseEndsAt = String(item.releaseEndsAt || '');
    try {
      const effectiveSchedule = {
        ...GOYUNIR_STORE_SUITE.dropSchedule,
        ...(globalSchedule || {}),
        ...((item as any).customDropSchedule || {}),
      };
      const nextAnchorMs = resolveNextRaffleAnchorMs(lifecycleProduct as any, effectiveSchedule as any, now);
      if (nextAnchorMs !== null) nextReleaseEndsAt = formatStoreWallClock(nextAnchorMs, timezone);
    } catch {
      /* a schedule glitch must never break the store payload */
    }

    return { ...lifecycleProduct, nextReleaseEndsAt };
  });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedSlug = String(url.searchParams.get('slug') || '').trim();

    const payload = await withTtlCache(`store:${requestedSlug || '*'}:v1`, 10_000, () => buildStorePayload(requestedSlug));
    return NextResponse.json(payload);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
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
