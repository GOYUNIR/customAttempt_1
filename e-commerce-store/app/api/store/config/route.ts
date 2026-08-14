import { NextResponse, type NextRequest } from 'next/server';
import { createRedisClient, safeParseRedisItem , getAdminPassword, STORE_CONFIG_KEY, PRODUCTS_KEY, SCHEDULE_OVERRIDE_KEY, SOCIAL_PROOF_OVERRIDE_KEY} from '@/lib/server-config';
import { getSessionUser } from '@/lib/session-auth';
import { mergeOrbsConfig } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

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
    cardTextMain: '#ffffff',
    cardTextMuted: '#c9c9d3',
    checkoutCtaButton: '#635bff',
    fontFamily: "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    borderRadius: 12,
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
    eyebrow: 'HIGH-CADENCE RELEASES',
    headline: 'Luxury releases with private-club energy, built for decisive collectors.',
    body: 'Handmade, low-volume, and intentionally scarce. Each release is tuned for trust, speed, and the feeling that not everyone gets through.',
    ctaLabel: 'Browse drops',
    storyHeadline: 'Our Story',
    storyBody: 'Low supply. Fast conversion. Quiet exclusivity.',
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
    instagramLink: '',
    tiktokLink: '',
    supportEmail: '',
    shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
    corporateEntityCopyright: 'ALL RIGHTS RESERVED.',
  },
  catalogPreview: {
    upcomingDrops: [],
    archiveScents: [],
  },
  orbs: {
    enabled: true,
    topBar: { enabled: true, color: '#7dd3fc', opacity: 34, size: 210 },
    primary: { enabled: true, color: '#3b82f6', opacity: 16, size: 58 },
    secondary: { enabled: true, color: '#a855f7', opacity: 26, size: 44 },
    tertiary: { enabled: true, color: '#ffd79b', opacity: 12, size: 28 },
    motion: {
      idleEnabled: true,
      pointerEnabled: true,
      scrollEnabled: true,
      intensity: 100,
      speed: 100,
      momentum: 40,
    },
  },
  legal: {
    companyName: '',
    supportEmail: '',
    terms: '',
    privacy: '',
    shipping: '',
  },
};

export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const adminPassword = getAdminPassword() || '';
    const isAuthorized = Boolean((sessionUser && sessionUser.role === 'admin') || (adminPassword && bearer === adminPassword));
    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const requestedSlug = searchParams.get('slug');

    const redis = createRedisClient();
    const sortProducts = (items: StoreProduct[]) => [...items].sort((a, b) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)));

    const configRaw = redis ? await redis.get(STORE_CONFIG_KEY) : null;
    const config = safeParseRedisItem<any>(configRaw) || DEFAULT_CONFIG;
    const effectiveConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      themeColors: { ...DEFAULT_CONFIG.themeColors, ...(config?.themeColors || {}) },
      availableSizes: Array.isArray(config?.availableSizes) && config.availableSizes.length > 0 ? config.availableSizes : DEFAULT_CONFIG.availableSizes,
      homeRedirectSlug: typeof config?.homeRedirectSlug === 'string' && config.homeRedirectSlug.trim() && !['elysian-white','obsidian-void'].includes(config.homeRedirectSlug) ? config.homeRedirectSlug : DEFAULT_CONFIG.homeRedirectSlug,
      orbs: mergeOrbsConfig(config?.orbs || DEFAULT_CONFIG.orbs),
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

    // Single read of the canonical product hash, then derive sections by flags.
    // Images are already embedded in each product object (no N+1 lookups).
    let allProducts: StoreProduct[] = [];
    const allRaw = await redis.hgetall(PRODUCTS_KEY);
    if (allRaw) {
      for (const value of Object.values(allRaw)) {
        const p = safeParseRedisItem<StoreProduct>(value);
        if (p) allProducts.push(p);
      }
    }

    let activeProducts = allProducts.filter((p) => p.isActive && !p.isArchived && !p.isUpcoming);
    let archivedProducts = allProducts.filter((p) => p.isArchived);
    let upcomingProducts = allProducts.filter((p) => p.isUpcoming && !p.isArchived);

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
    const scheduleRaw = await redis.get(SCHEDULE_OVERRIDE_KEY);
    const scheduleOverride = safeParseRedisItem<any>(scheduleRaw) || {};

    // Get social proof override
    const socialRaw = await redis.get(SOCIAL_PROOF_OVERRIDE_KEY);
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