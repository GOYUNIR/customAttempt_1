import { NextResponse } from 'next/server';
import {
  aggregateLiveInventoryByProduct,
  createRedisClient,
  findLiveInventoryForProduct,
  getFallbackStoreProducts,
  listLiveStates,
  loadStoreConfig,
  safeParseRedisItem,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

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
  soldOutBehavior?: string;
  soldOutArchiveDelayHours?: number;
  soldOutAt?: string;
};

function toMs(value: unknown) {
  const parsed = typeof value === 'string' && value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
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
    soldOutBehavior: String(raw?.soldOutBehavior || 'stay_visible'),
    soldOutArchiveDelayHours: Math.max(0, Number(raw?.soldOutArchiveDelayHours || 0)),
    soldOutAt: String(raw?.soldOutAt || ''),
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
    heroContent: { ...(defaults.heroContent || {}), ...(redisConfig.heroContent || {}) },
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
  };
}

function applyLifecycle(
  products: PublicStoreProduct[],
  liveStates: Awaited<ReturnType<typeof listLiveStates>>,
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
    // Only sold out when inventory was configured and remaining hits zero.
    const soldOut = totalInventory > 0 && inventoryRemaining <= 0;
    const goLiveAtMs = toMs(item.goLiveAt);
    const soldOutAtMs = toMs(item.soldOutAt);
    const shouldGoLive = item.isUpcoming && goLiveAtMs !== null && now >= goLiveAtMs;
    const shouldArchiveFromSoldOut = soldOut && item.soldOutBehavior === 'archive_now';
    const shouldArchiveAfterDelay =
      soldOut &&
      item.soldOutBehavior === 'archive_after_delay' &&
      soldOutAtMs !== null &&
      now >= soldOutAtMs + Math.max(0, Number(item.soldOutArchiveDelayHours || 0)) * 60 * 60 * 1000;

    return {
      ...item,
      inventoryRemaining,
      totalInventory,
      soldOut,
      isUpcoming: shouldGoLive ? false : item.isUpcoming,
      isArchived: shouldArchiveFromSoldOut || shouldArchiveAfterDelay ? true : item.isArchived,
      isActive: shouldGoLive ? true : item.isActive,
    };
  });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedSlug = String(url.searchParams.get('slug') || '').trim();

    const redis = createRedisClient();
    const sortProducts = (items: PublicStoreProduct[]) =>
      [...items].sort(
        (a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)),
      );

    if (!redis) {
      const fallbackProducts = sortProducts(Object.values(getFallbackStoreProducts()).map(sanitizeProduct));
      const lifecycleProducts = applyLifecycle(fallbackProducts, []);
      const activeProducts = lifecycleProducts.filter((item) => item.isActive && !item.isArchived && !item.isUpcoming);
      const archivedProducts = lifecycleProducts.filter((item) => item.isArchived);
      const upcomingProducts = lifecycleProducts.filter((item) => item.isUpcoming && !item.isArchived);
      const product = requestedSlug
        ? lifecycleProducts.find((item) => item.slug === requestedSlug) || null
        : null;

      return NextResponse.json({
        config: mergePublicConfig({}),
        activeProducts,
        archivedProducts,
        upcomingProducts,
        allProducts: lifecycleProducts,
        product,
        scheduleOverride: {},
        socialOverride: {},
        timestamp: Date.now(),
        fromFallback: true,
      });
    }

    const config = mergePublicConfig(await loadStoreConfig(redis));
    const liveStates = await listLiveStates(redis);

    let allProducts: PublicStoreProduct[] = [];
    const allRaw = await redis.hgetall('store:products');
    if (allRaw) {
      for (const value of Object.values(allRaw)) {
        const p = safeParseRedisItem<any>(value);
        if (p) allProducts.push(sanitizeProduct(p));
      }
    }

    // Redis empty → serve config fallbacks so the storefront is never blank.
    if (allProducts.length === 0) {
      allProducts = Object.values(getFallbackStoreProducts()).map(sanitizeProduct);
    }

    allProducts = sortProducts(allProducts);
    const lifecycleProducts = applyLifecycle(allProducts, liveStates);
    const activeProducts = lifecycleProducts.filter((item) => item.isActive && !item.isArchived && !item.isUpcoming);
    const archivedProducts = lifecycleProducts.filter((item) => item.isArchived);
    const upcomingProducts = lifecycleProducts.filter((item) => item.isUpcoming && !item.isArchived);

    const product = requestedSlug
      ? lifecycleProducts.find((item) => item.slug === requestedSlug) || null
      : null;

    const scheduleRaw = await redis.get('config:drop_schedule');
    const scheduleOverride = safeParseRedisItem<any>(scheduleRaw) || {};
    const socialRaw = await redis.get('config:social_proof');
    const socialOverride = safeParseRedisItem<any>(socialRaw) || {};

    return NextResponse.json({
      config,
      activeProducts,
      archivedProducts,
      upcomingProducts,
      allProducts: lifecycleProducts,
      product,
      scheduleOverride,
      socialOverride,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
