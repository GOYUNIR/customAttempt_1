import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const CONFIG_KEY = 'store:config';
const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const IMAGES_KEY = 'store:product_images';

type StoreProduct = {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  price50ml: number;
  price100ml: number;
  stripeId50ml: string;
  stripeId100ml: string;
  maxRaffleAllocationLimit: number;
  isActive: boolean;
  isArchived: boolean;
  notes: { label: string; name: string; text: string }[];
  images: string[];
  totalInventory: number;
  winnerTiers: number[];
  createdAt: string;
  updatedAt: string;
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
  availableSizes: ['50ml'],
  homeRedirectSlug: undefined,
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

export async function GET() {
  try {
    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({ 
        config: DEFAULT_CONFIG,
        activeProducts: [],
        archivedProducts: [],
        allProducts: [],
        scheduleOverride: {},
        socialOverride: {},
        timestamp: Date.now(),
        fromCache: false,
        note: 'Redis unavailable - using default config'
      });
    }

    // Get store config
    const configRaw = await redis.get(CONFIG_KEY);
    const config = safeParseRedisItem<any>(configRaw) || DEFAULT_CONFIG;

    // Get all active products
    const activeRaw = await redis.hgetall(ACTIVE_PRODUCTS_KEY);
    const activeProducts: StoreProduct[] = [];
    if (activeRaw) {
      for (const [k, v] of Object.entries(activeRaw)) {
        const p = safeParseRedisItem<StoreProduct>(v);
        if (p) {
          // Load images for this product
          const imgKey = `${IMAGES_KEY}:${p.id}`;
          const imgRaw = await redis.get(imgKey);
          const images = safeParseRedisItem<string[]>(imgRaw) || p.images || [];
          activeProducts.push({ ...p, images });
        }
      }
    }

    // Get archived products
    const archivedRaw = await redis.hgetall(ARCHIVED_PRODUCTS_KEY);
    const archivedProducts: StoreProduct[] = [];
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

    // Get all products
    const allRaw = await redis.hgetall(PRODUCTS_KEY);
    const allProducts: StoreProduct[] = [];
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

    // Get global schedule override
    const scheduleRaw = await redis.get('config:drop_schedule');
    const scheduleOverride = safeParseRedisItem<any>(scheduleRaw) || {};

    // Get social proof override
    const socialRaw = await redis.get('config:social_proof');
    const socialOverride = safeParseRedisItem<any>(socialRaw) || {};

    return NextResponse.json({
      config,
      activeProducts,
      archivedProducts,
      allProducts,
      scheduleOverride,
      socialOverride,
      timestamp: Date.now(),
      fromCache: false,
    });
  } catch (err: any) {
    return NextResponse.json({ 
      error: err.message,
      config: DEFAULT_CONFIG,
      activeProducts: [],
      archivedProducts: [],
      allProducts: [],
      scheduleOverride: {},
      socialOverride: {},
      timestamp: Date.now(),
      fromCache: true,
    }, { status: 500 });
  }
}