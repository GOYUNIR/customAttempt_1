import { NextResponse } from 'next/server';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';
const CONFIG_KEY = 'store:config';
const CATALOG_CONFIG_KEY = 'store:catalog_config';

// Seeded products – now using priceCategories, no price50ml/100ml.
const NOW = new Date().toISOString();
const DEFAULT_PRODUCTS = [
  {
    id: 'p1', name: 'Elysian White — Launch Draw', slug: 'elysian-white-launch-draw', prefix: 'elysian-white', tagline: 'RAFFLE / LIVE', desc: 'Primary hero raffle drop with tight allocation.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 0,
    notes: [{ label: 'DRAW', name: 'Allocation', text: 'Card is saved now, charged only if selected.' }],
    priceCategories: [{ size: 'Standard', price: 95, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '3,2,2' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 120, totalInventory: 120, winnerTiers: [3, 2, 2], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p2', name: 'Obsidian Void — Priority Draw', slug: 'obsidian-void-priority-draw', prefix: 'obsidian-void', tagline: 'RAFFLE / LIVE', desc: 'High-intent raffle queue with limited winners.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 1,
    notes: [{ label: 'DRAW', name: 'Priority Access', text: 'Entries are reviewed and charged only if selected.' }],
    priceCategories: [{ size: 'Standard', price: 110, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,2,1' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 90, totalInventory: 90, winnerTiers: [2, 2, 1], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p3', name: 'Noir Citrus — Instant Drop', slug: 'noir-citrus-instant-drop', prefix: 'baseItem1', tagline: 'FCFS / LIVE', desc: 'Fast-checkout direct buy drop for cart flow.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 2,
    notes: [{ label: 'BUY', name: 'Instant', text: 'Immediate purchase and fulfillment queue.' }],
    priceCategories: [{ size: 'Standard', price: 145, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 160, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p4', name: 'Amber Pulse — Direct Release', slug: 'amber-pulse-direct-release', prefix: 'baseItem2', tagline: 'FCFS / LIVE', desc: 'Cart-compatible direct release for mixed traffic.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 3,
    notes: [{ label: 'BUY', name: 'Direct', text: 'Checkout starts instantly from product or cart.' }],
    priceCategories: [{ size: 'Standard', price: 130, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 140, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p5', name: 'Velvet Resin — Upcoming', slug: 'velvet-resin-upcoming', prefix: 'elysian-white', tagline: 'UPCOMING / QUEUED', desc: 'Queued release to simulate upcoming placement.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 4,
    notes: [{ label: 'QUEUE', name: 'Upcoming', text: 'Not live yet; appears in upcoming sections.' }],
    priceCategories: [{ size: 'Standard', price: 99, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,1,1' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 70, totalInventory: 70, winnerTiers: [2, 1, 1], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p6', name: 'Solar Drift — Upcoming FCFS', slug: 'solar-drift-upcoming-fcfs', prefix: 'baseItem1', tagline: 'UPCOMING / FCFS', desc: 'Upcoming direct-buy release for catalog simulation.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 5,
    notes: [{ label: 'QUEUE', name: 'Upcoming FCFS', text: 'Pending direct-buy launch in upcoming grid.' }],
    priceCategories: [{ size: 'Standard', price: 122, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 95, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p7', name: 'Monolith Air — Upcoming', slug: 'monolith-air-upcoming', prefix: 'obsidian-void', tagline: 'UPCOMING / RAFFLE', desc: 'Upcoming raffle entry with low allocation.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 6,
    notes: [{ label: 'QUEUE', name: 'Low Allocation', text: 'Short-run release staged in upcoming.' }],
    priceCategories: [{ size: 'Standard', price: 104, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '1,1,1' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 45, totalInventory: 45, winnerTiers: [1, 1, 1], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p8', name: 'Atlas Bloom — Archive', slug: 'atlas-bloom-archive', prefix: 'baseItem2', tagline: 'ARCHIVE', desc: 'Completed release to populate archived catalog state.',
    isActive: true, isArchived: true, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 7,
    notes: [{ label: 'ARCHIVE', name: 'Past Drop', text: 'Previously sold release for social proof.' }],
    priceCategories: [{ size: 'Standard', price: 118, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 0, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p9', name: 'Cinder Wave — Archive', slug: 'cinder-wave-archive', prefix: 'baseItem1', tagline: 'ARCHIVE', desc: 'Historic raffle archive entry to test old winner records.',
    isActive: true, isArchived: true, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 8,
    notes: [{ label: 'ARCHIVE', name: 'Historic Draw', text: 'Past draw sample for timeline realism.' }],
    priceCategories: [{ size: 'Standard', price: 102, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,2' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 0, winnerTiers: [2, 2], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p10', name: 'Mirage Salt — Hidden Draft', slug: 'mirage-salt-hidden-draft', prefix: 'baseItem2', tagline: 'DRAFT', desc: 'Hidden draft to simulate non-published product records.',
    isActive: false, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 9,
    notes: [{ label: 'DRAFT', name: 'Hidden', text: 'Invisible until explicitly published.' }],
    priceCategories: [{ size: 'Standard', price: 128, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 60, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p11', name: 'Night Petal — Live Draw', slug: 'night-petal-live-draw', prefix: 'elysian-white', tagline: 'RAFFLE / LIVE', desc: 'Secondary live raffle to verify multi-draw storefront behavior.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 10,
    notes: [{ label: 'DRAW', name: 'Secondary Pool', text: 'Parallel raffle for realistic active catalog volume.' }],
    priceCategories: [{ size: 'Standard', price: 108, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,1,1' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 80, totalInventory: 80, winnerTiers: [2, 1, 1], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p12', name: 'Quartz Ember — Live FCFS', slug: 'quartz-ember-live-fcfs', prefix: 'obsidian-void', tagline: 'FCFS / LIVE', desc: 'Additional direct buy listing to stress-test cart and checkout UX.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 11,
    notes: [{ label: 'BUY', name: 'Cart Flow', text: 'Direct product designed for multi-item cart simulation.' }],
    priceCategories: [{ size: 'Standard', price: 152, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 3, maxPerCart: 3, maxRaffleAllocationLimit: 0, totalInventory: 180, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
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
  homeRedirectSlug: 'elysian-white-launch-draw',
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
    upcomingDrops: [
      { name: 'Velvet Resin — Upcoming', status: 'Upcoming', eta: 'Soon', image: '/images/elysian-white/1.jpeg', description: 'Queued release preparing for launch.', slug: 'velvet-resin-upcoming' },
      { name: 'Solar Drift — Upcoming FCFS', status: 'Upcoming', eta: 'Soon', image: '/images/baseItem1/1.jpeg', description: 'Direct purchase drop entering queue.', slug: 'solar-drift-upcoming-fcfs' },
      { name: 'Monolith Air — Upcoming', status: 'Upcoming', eta: 'Soon', image: '/images/obsidian-void/1.jpeg', description: 'Low allocation raffle arriving next.', slug: 'monolith-air-upcoming' },
    ],
    archiveScents: [
      { name: 'Atlas Bloom — Archive', status: 'Archived', image: '/images/baseItem2/1.jpeg', description: 'Completed direct drop in the archive lane.', slug: 'atlas-bloom-archive' },
      { name: 'Cinder Wave — Archive', status: 'Archived', image: '/images/baseItem1/1.jpeg', description: 'Historic raffle archive record.', slug: 'cinder-wave-archive' },
    ],
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

    await Promise.all([
      redis.del(ACTIVE_PRODUCTS_KEY),
      redis.del(ARCHIVED_PRODUCTS_KEY),
      redis.del(UPCOMING_PRODUCTS_KEY),
    ]);

    let seeded = 0;
    for (const product of DEFAULT_PRODUCTS) {
      await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      if (product.isActive) {
        await redis.hset(ACTIVE_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      }
      if (product.isArchived) {
        await redis.hset(ARCHIVED_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      }
      if (product.isUpcoming) {
        await redis.hset(UPCOMING_PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
      }
      seeded++;
    }

    await redis.set(CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));
    await redis.set(CATALOG_CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG.catalogPreview));

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