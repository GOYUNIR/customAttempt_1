import { NextResponse, type NextRequest } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';

export const dynamic = 'force-dynamic';

const CONFIG_KEY = 'store:config';
const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';
const IMAGES_KEY = 'store:product_images';

type StoreProduct = {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  sortOrder?: number;
  priceCategories?: Array<{ size: string; price: number; stripeId: string; winnerTiers?: string | number[] }>;
  maxRaffleAllocationLimit: number;
  isActive: boolean;
  isArchived: boolean;
  isUpcoming: boolean;
  notes: { label: string; name: string; text: string }[];
  images: string[];
  totalInventory: number;
  winnerTiers: number[];
  createdAt?: string;
  updatedAt?: string;
};

const DEFAULT_CONFIG = {
  themeColors: {
    primaryBackground: '#0a0a0a',
    cardBackground: '#111111',
    cardBorder: '#222222',
    accentPurple: '#a855f7',
    accentBlue: '#3b82f6',
    textMain: '#ffffff',
    textMuted: '#888888',
    checkoutCtaButton: '#635bff',
  },
  availableSizes: ['Standard'],
  homeRedirectSlug: 'elysian-white-launch-draw',
  dropSchedule: {
    mode: 'daily',
    timezone: 'America/Los_Angeles',
    targetEndDateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', 'T') + ':00',
    drawDayOfWeek: 6,
    drawDayOfMonth: 1,
    drawHour: 21,
    drawMinute: 0,
    drawSecond: 0,
    countdownExpiredText: 'ALLOCATION. CLOSED • VARIANT ARCHIVED',
    daysLabel: 'd',
    hoursLabel: 'h',
    minutesLabel: 'm',
    secondsLabel: 's',
    winnersPer50ml: 0,
    winnersPer100ml: 0,
  },
  animationMechanics: {
    totalFramesToLoad: 29,
    maxRotationDegrees: 360,
    spinReverseOnAlternatingProgress: false,
    spinCyclesTopToCheckout: 1,
  },
  raffleRegistrationForm: {
    titleHeader: 'Join The Allocation Draw',
    emailLabel: 'Contact Email Address',
    emailPlaceholder: 'name@domain.com',
    addressLabel: 'Full Shipping Destination',
    addressPlaceholder: '123 Luxury Dr, New York, NY',
    submitButtonText: '🏆 Secure Entry Allocation Ticket',
    submitButtonLoadingText: 'Encrypting Entry Base...',
  },
  heroContent: {
    eyebrow: 'The Architecture of Scent',
    headline: 'A drop that moves faster than attention itself.',
    body: 'We design fragrances that move faster than time itself.',
    ctaLabel: '↓ Scroll To Explore',
  },
  socialProof: {
    label: 'Limited drop access',
    baseCount: 0,
    caption: 'Hype is compounding fast—reserve now before inventory closes.',
    autoIncrementEnabled: true,
    autoIncrementChancePerHeartbeat: 0.15,
    autoIncrementAmount: 1,
    autoIncrementMaxPerDay: 4,
    autoIncrementMinHourGap: 3,
    autoIncrementMaxHourGap: 8,
  },
  brandFooterData: {
    instagramLink: 'https://instagram.com/goyunir',
    tiktokLink: 'https://tiktok.com/goyunir',
    supportEmail: 'goyunir.support@gmail.com',
    shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
    corporateEntityCopyright: 'GOYUNIR ALL RIGHTS RESERVED.',
  },
  catalogPreview: {
    upcomingDrops: [],
    archiveScents: [],
  },
};

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const adminPassword = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    const isAuthorized = Boolean((sessionUser && sessionUser.role === 'admin') || (adminPassword && bearer === adminPassword));
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const requestedSlug = searchParams.get('slug');

    const redis = createRedisClient();
    const sortProducts = (items: StoreProduct[]) => [...items].sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)));

    const configRaw = redis ? await redis.get(CONFIG_KEY) : null;
    const config = safeParseRedisItem<any>(configRaw) || DEFAULT_CONFIG;
    const effectiveConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      themeColors: { ...DEFAULT_CONFIG.themeColors, ...(config?.themeColors || {}) },
      availableSizes: Array.isArray(config?.availableSizes) && config.availableSizes.length > 0 ? config.availableSizes : DEFAULT_CONFIG.availableSizes,
      homeRedirectSlug: typeof config?.homeRedirectSlug === 'string' && config.homeRedirectSlug.trim() && !['elysian-white','obsidian-void'].includes(config.homeRedirectSlug) ? config.homeRedirectSlug : DEFAULT_CONFIG.homeRedirectSlug,
    };

    if (!redis) {
      return NextResponse.json({
        config: effectiveConfig,
        activeProducts: [],
        archivedProducts: [],
        upcomingProducts: [],
        allProducts: [],
        product: null,
        scheduleOverride: {},
        socialOverride: {},
        timestamp: Date.now(),
        fromCache: true,
        note: 'Redis unavailable'
      });
    }

    let activeProducts: StoreProduct[] = [];
    let archivedProducts: StoreProduct[] = [];
    let upcomingProducts: StoreProduct[] = [];
    let allProducts: StoreProduct[] = [];

    // Get active products from Redis
    const activeRaw = await redis.hgetall(ACTIVE_PRODUCTS_KEY);
    if (activeRaw) {
      for (const [k, v] of Object.entries(activeRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || p.images || [];
          activeProducts.push({ ...p, images });
        }
      }
    }

    // Get archived products
    const archivedRaw = await redis.hgetall(ARCHIVED_PRODUCTS_KEY);
    if (archivedRaw) {
      for (const [k, v] of Object.entries(archivedRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || p.images || [];
          archivedProducts.push({ ...p, images });
        }
      }
    }

    // Get upcoming products
    const upcomingRaw = await redis.hgetall(UPCOMING_PRODUCTS_KEY);
    if (upcomingRaw) {
      for (const [k, v] of Object.entries(upcomingRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || p.images || [];
          upcomingProducts.push({ ...p, images });
        }
      }
    }

    // Get all products
    const allRaw = await redis.hgetall(PRODUCTS_KEY);
    if (allRaw) {
      for (const [k, v] of Object.entries(allRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || p.images || [];
          allProducts.push({ ...p, images });
        }
      }
    }

    {
      activeProducts = sortProducts(activeProducts);
      archivedProducts = sortProducts(archivedProducts);
      upcomingProducts = sortProducts(upcomingProducts);
      allProducts = sortProducts(allProducts);
    }

    const resolvedProduct = requestedSlug
      ? allProducts.find((product) => product.slug === requestedSlug)
        || activeProducts.find((product) => product.slug === requestedSlug)
        || archivedProducts.find((product) => product.slug === requestedSlug)
        || null
      : null;

    // Get global schedule override
    const scheduleRaw = await redis.get('config:drop_schedule');
    const scheduleOverride = safeParseRedisItem<any>(scheduleRaw) || {};

    // Get social proof override
    const socialRaw = await redis.get('config:social_proof');
    const socialOverride = safeParseRedisItem<any>(socialRaw) || {};

    return NextResponse.json({
      config: effectiveConfig,
      activeProducts,
      archivedProducts,
      upcomingProducts,
      allProducts,
      product: resolvedProduct,
      scheduleOverride,
      socialOverride,
      timestamp: Date.now(),
      fromCache: false,
    });
  } catch (err: any) {
    console.error('[store/config] Error:', err);
    return NextResponse.json({
      error: err.message,
      config: DEFAULT_CONFIG,
      activeProducts: [],
      archivedProducts: [],
      upcomingProducts: [],
      allProducts: [],
      product: null,
      scheduleOverride: {},
      socialOverride: {},
      timestamp: Date.now(),
      fromCache: true,
    }, { status: 500 });
  }
}