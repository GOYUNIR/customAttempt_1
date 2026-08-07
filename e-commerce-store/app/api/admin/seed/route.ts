import { NextResponse } from 'next/server';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';
const CONFIG_KEY = 'store:config';

// Seeded products – now using priceCategories, no price50ml/100ml.
const DEFAULT_PRODUCTS = [
  {
    id: 'p1',
    name: 'Drop 01 — Raffle Access',
    slug: 'drop-01-raffle-access',
    prefix: 'drop-01',
    tagline: 'LIMITED Raffle / 01',
    desc: 'A premium release designed for raffle entry and controlled allocation.',
    isActive: true,
    isArchived: false,
    isUpcoming: false,
    isRaffle: true,
    productType: 'raffle',
    sortOrder: 0,
    notes: [
      { label: 'DROP', name: 'Raffle Access', text: 'Entry is limited and managed through the admin-controlled draw system.' },
    ],
    priceCategories: [
      { size: 'Standard', price: 95, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,2,1' }
    ],
    images: ['/images/baseItem1/1.jpeg'],
    maxRaffleAllocationLimit: 100,
    totalInventory: 100,
    winnerTiers: [2, 2, 1],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'p2',
    name: 'Drop 02 — Direct Buy',
    slug: 'drop-02-direct-buy',
    prefix: 'drop-02',
    tagline: 'DIRECT BUY / 02',
    desc: 'A ready-to-purchase release for immediate checkout and cart fulfillment.',
    isActive: true,
    isArchived: false,
    isUpcoming: false,
    isRaffle: false,
    productType: 'checkout',
    sortOrder: 1,
    notes: [
      { label: 'BUY NOW', name: 'Instant Checkout', text: 'This item can be purchased immediately and added to cart.' },
    ],
    priceCategories: [
      { size: 'Standard', price: 145, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }
    ],
    images: ['/images/baseItem2/1.jpeg'],
    maxRaffleAllocationLimit: 0,
    totalInventory: 120,
    winnerTiers: [0],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
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
  availableSizes: ['Standard'],
  homeRedirectSlug: 'drop-01-raffle-access',
  dropSchedule: {
    mode: 'daily',
    timezone: 'America/Los_Angeles',
    targetEndDateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16)
      .replace('T', 'T') + ':00',
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

    const existing = await redis.hgetall(PRODUCTS_KEY);
    if (existing && Object.keys(existing).length > 0) {
      return NextResponse.json({
        success: true,
        message: `Products already exist in Redis (${Object.keys(existing).length} products). No seeding needed.`,
        count: Object.keys(existing).length,
      });
    }

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

    await redis.set(CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));

    const verify = await redis.hgetall(PRODUCTS_KEY);
    const verifyCount = verify ? Object.keys(verify).length : 0;

    return NextResponse.json({
      success: true,
      message: `Seeded ${seeded} products to Redis. Verified: ${verifyCount} products exist.`,
      products: DEFAULT_PRODUCTS.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
      verified: verifyCount,
    });
  } catch (err: any) {
    console.error('[seed] Error:', err);
    return NextResponse.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}