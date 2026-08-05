import { NextResponse } from 'next/server';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';
const CONFIG_KEY = 'store:config';

const DEFAULT_PRODUCTS = [
  {
    id: 'p1',
    name: 'Elysian White',
    slug: 'elysian-white',
    prefix: 'elysian-white',
    tagline: 'WHITE ALLOCATION / 01',
    desc: 'Clean, electric profile variant constructed with premium bergamot.',
    price50ml: 85,
    price100ml: 140,
    stripeId50ml: 'price_1TxGXQPIsR6ijfBZUKefFNOI',
    stripeId100ml: 'price_1Txn9YPIsR6ijfBZJZhSdHEr',
    maxRaffleAllocationLimit: 10,
    isActive: true,
    isArchived: false,
    isUpcoming: false,
    notes: [
      { label: 'TOP PROFILE', name: 'White Bergamot', text: 'Crisp Sicilian bergamot crushed with volcanic pink pepper.' },
      { label: 'HEART PROFILE', name: 'Citrus Flash', text: 'Fresh, electric burst optimized to capture immediate attention.' },
      { label: 'BASE PROFILE', name: 'Clean Musk', text: 'A smooth velvet finish that lingers delicately on fabrics.' }
    ],
    images: Array.from({ length: 29 }, (_, i) => `/images/elysian-white/${i + 1}.jpeg`),
    totalInventory: 9,
    winnerTiers: [2, 2, 2, 2, 1],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'p2',
    name: 'Obsidian Void',
    slug: 'obsidian-void',
    prefix: 'obsidian-void',
    tagline: 'BLACK ALLOCATION / 02',
    desc: 'Deep, smoke-infused wood profile variant designed for lasting depth.',
    price50ml: 85,
    price100ml: 140,
    stripeId50ml: 'price_1TxnJ3PIsR6ijfBZUFXVhIfF',
    stripeId100ml: 'price_1TxnJpPIsR6ijfBZVvlrffeO',
    maxRaffleAllocationLimit: 5,
    isActive: true,
    isArchived: false,
    isUpcoming: false,
    notes: [
      { label: 'TOP PROFILE', name: 'Midnight Spice', text: 'A dark sensory introduction of clove and rare cardamom.' },
      { label: 'HEART PROFILE', name: 'Obsidian Amber', text: 'Midnight jasmine absolute bleeding into raw vetiver roots.' },
      { label: 'BASE PROFILE', name: 'Earthy Timber', text: 'A rich cedarwood base that deepens as the hours develop.' }
    ],
    images: Array.from({ length: 29 }, (_, i) => `/images/obsidian-void/${i + 1}.jpeg`),
    totalInventory: 5,
    winnerTiers: [1],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
];

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
  homeRedirectSlug: 'elysian-white',
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
    winnersPer50ml: 10,
    winnersPer100ml: 5,
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({ error: 'Redis offline' }, { status: 500 });
    }

    // Check if products already exist
    const existing = await redis.hgetall(PRODUCTS_KEY);
    if (existing && Object.keys(existing).length > 0) {
      return NextResponse.json({ 
        success: true, 
        message: `Products already exist in Redis (${Object.keys(existing).length} products). No seeding needed.`,
        count: Object.keys(existing).length
      });
    }

    // Seed products
    let seeded = 0;
    for (const product of DEFAULT_PRODUCTS) {
      await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      if (product.isActive && !product.isArchived && !product.isUpcoming) {
        await redis.hset(ACTIVE_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      } else if (product.isArchived) {
        await redis.hset(ARCHIVED_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      } else if (product.isUpcoming) {
        await redis.hset(UPCOMING_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      }
      seeded++;
    }

    // Save config
    await redis.set(CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));

    // Verify seeding worked
    const verify = await redis.hgetall(PRODUCTS_KEY);
    const verifyCount = verify ? Object.keys(verify).length : 0;

    return NextResponse.json({
      success: true,
      message: `Seeded ${seeded} products to Redis. Verified: ${verifyCount} products exist.`,
      products: DEFAULT_PRODUCTS.map(p => ({ id: p.id, name: p.name, slug: p.slug })),
      verified: verifyCount
    });
  } catch (err: any) {
    console.error('[seed] Error:', err);
    return NextResponse.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}