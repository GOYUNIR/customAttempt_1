import { NextResponse } from 'next/server';
import { createRedisClient , getAdminPassword} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PRODUCTS_KEY = 'store:products';
const ACTIVE_PRODUCTS_KEY = 'store:active_products';
const ARCHIVED_PRODUCTS_KEY = 'store:archived_products';
const UPCOMING_PRODUCTS_KEY = 'store:upcoming_products';
const CONFIG_KEY = 'store:config';
const CATALOG_CONFIG_KEY = 'store:catalog_config';

// Seeded products – now using priceCategories, no price50ml/100ml.
const NOW = new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const isoIn = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19);
const DEFAULT_PRODUCTS = [
  {
    id: 'p1', name: 'Elysian White — Launch Draw', slug: 'elysian-white-launch-draw', prefix: 'elysian-white', tagline: 'RAFFLE / LIVE', desc: 'Primary hero raffle drop with tight allocation.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 0,
    notes: [{ label: 'MODE', name: 'Live raffle', text: 'Best for manufactured scarcity, waitlist growth, and careful winner selection.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Feels exclusive and fair, but customers wait for the charge instead of converting instantly.' }],
    priceCategories: [{ size: 'Standard', price: 95, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '3,2,2' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 120, totalInventory: 120, winnerTiers: [3, 2, 2], releaseEndsAt: isoIn(2 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 48, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p2', name: 'Obsidian Void — Priority Draw', slug: 'obsidian-void-priority-draw', prefix: 'obsidian-void', tagline: 'RAFFLE / LIVE', desc: 'High-intent raffle queue with limited winners.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 1,
    notes: [{ label: 'MODE', name: 'Priority raffle', text: 'Useful when a client wants social buzz without opening unlimited direct checkout.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Excellent for social proof and promoter traffic, but lower instant revenue than FCFS.' }],
    priceCategories: [{ size: 'Standard', price: 110, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,2,1' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 90, totalInventory: 90, winnerTiers: [2, 2, 1], releaseEndsAt: isoIn(3 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 72, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p3', name: 'Noir Citrus — Instant Drop', slug: 'noir-citrus-instant-drop', prefix: 'baseItem1', tagline: 'FCFS / LIVE', desc: 'Fast-checkout direct buy drop for cart flow.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 2,
    notes: [{ label: 'MODE', name: 'Live FCFS', text: 'Best for immediate conversion from social clicks and high-speed product demand.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Fastest checkout path, but it can sell through instantly without the anticipation of a draw.' }],
    priceCategories: [{ size: 'Sampler Set', price: 19, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }, { size: 'Full Bottle', price: 145, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 160, winnerTiers: [0], soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 24, deliveryIncentiveEnabled: true, deliveryIncentiveCreditCents: 1500, deliveryIncentiveMinOrderSubtotalCents: 9000, deliveryIncentiveExpiresDays: 60, deliveryIncentiveCodePrefix: 'NOIR', deliveryIncentiveTriggerSizes: ['Sampler Set'], deliveryIncentiveEligibleProductSlugs: ['noir-citrus-instant-drop'], deliveryIncentiveEligibleSizes: ['Full Bottle'], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p4', name: 'Amber Pulse — Direct Release', slug: 'amber-pulse-direct-release', prefix: 'baseItem2', tagline: 'FCFS / LIVE', desc: 'Cart-compatible direct release for mixed traffic.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 3,
    notes: [{ label: 'MODE', name: 'Direct release', text: 'Great for polished launches where the goal is immediate revenue without raffle friction.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Excellent for speed and repeat purchases, but less selective than an allocation draw.' }],
    priceCategories: [{ size: 'Fabric Card', price: 24, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }, { size: 'Travel Spray', price: 62, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }, { size: 'Full Bottle', price: 130, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 140, winnerTiers: [0], soldOutBehavior: 'archive_after_delay', soldOutArchiveDelayHours: 18, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p5', name: 'Velvet Resin — Upcoming', slug: 'velvet-resin-upcoming', prefix: 'elysian-white', tagline: 'UPCOMING / QUEUED', desc: 'Queued release to simulate upcoming placement.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 4,
    notes: [{ label: 'MODE', name: 'Upcoming raffle', text: 'Builds anticipation before a controlled launch window and can still carry private-entry messaging.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Strong for countdown energy and promoter buildup, but not as immediately monetizable as FCFS.' }],
    priceCategories: [{ size: 'Standard', price: 99, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,1,1' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 70, totalInventory: 70, winnerTiers: [2, 1, 1], goLiveAt: isoIn(36 * 60 * 60 * 1000), releaseEndsAt: isoIn(5 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 48, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p6', name: 'Solar Drift — Upcoming FCFS', slug: 'solar-drift-upcoming-fcfs', prefix: 'baseItem1', tagline: 'UPCOMING / FCFS', desc: 'Upcoming direct-buy release for catalog simulation.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 5,
    notes: [{ label: 'MODE', name: 'Upcoming FCFS', text: 'Signals a precise opening moment for direct purchase traffic.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Great for countdown marketing and influencer drops, but inventory can disappear very quickly.' }],
    priceCategories: [{ size: 'Discovery Pair', price: 38, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }, { size: 'Collector Bottle', price: 122, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 95, winnerTiers: [0], goLiveAt: isoIn(60 * 60 * 1000), releaseEndsAt: isoIn(4 * DAY_MS), soldOutBehavior: 'archive_after_delay', soldOutArchiveDelayHours: 12, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p7', name: 'Monolith Air — Upcoming', slug: 'monolith-air-upcoming', prefix: 'obsidian-void', tagline: 'UPCOMING / RAFFLE', desc: 'Upcoming raffle entry with low allocation.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 6,
    notes: [{ label: 'MODE', name: 'Low-allocation upcoming', text: 'Simulates a very tight raffle with a visible countdown before activation.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'High exclusivity and strong anticipation, but deliberately low conversion capacity.' }],
    priceCategories: [{ size: 'Standard', price: 104, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '1,1,1' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 45, totalInventory: 45, winnerTiers: [1, 1, 1], goLiveAt: isoIn(2 * DAY_MS), releaseEndsAt: isoIn(6 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 72, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p8', name: 'Atlas Bloom — Archive', slug: 'atlas-bloom-archive', prefix: 'baseItem2', tagline: 'ARCHIVE', desc: 'Completed release to populate archived catalog state.',
    isActive: true, isArchived: true, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 7,
    notes: [{ label: 'MODE', name: 'Archive proof', text: 'Shows clients how sold-out or completed releases can remain visible as proof of demand.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Excellent social proof, but intentionally not the primary conversion surface anymore.' }],
    priceCategories: [{ size: 'Standard', price: 118, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 0, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p9', name: 'Cinder Wave — Archive', slug: 'cinder-wave-archive', prefix: 'baseItem1', tagline: 'ARCHIVE', desc: 'Historic raffle archive entry to test old winner records.',
    isActive: true, isArchived: true, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 8,
    notes: [{ label: 'MODE', name: 'Archive raffle', text: 'Lets a client demonstrate past allocation demand while keeping the page presentable.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Strong credibility and storytelling, but meant more for trust than instant sales.' }],
    priceCategories: [{ size: 'Standard', price: 102, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,2' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 0, winnerTiers: [2, 2], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p10', name: 'Mirage Salt — Hidden Draft', slug: 'mirage-salt-hidden-draft', prefix: 'baseItem2', tagline: 'DRAFT', desc: 'Hidden draft to simulate non-published product records.',
    isActive: false, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 9,
    notes: [{ label: 'MODE', name: 'Hidden draft', text: 'Shows how products can be staged privately before public release.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Ideal for preparation and QA, but invisible until activated.' }],
    priceCategories: [{ size: 'Standard', price: 128, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 60, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p11', name: 'Night Petal — Live Draw', slug: 'night-petal-live-draw', prefix: 'elysian-white', tagline: 'RAFFLE / LIVE', desc: 'Secondary live raffle to verify multi-draw storefront behavior.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 10,
    notes: [{ label: 'MODE', name: 'Secondary live draw', text: 'Demonstrates multiple simultaneous raffles inside the same storefront.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Great for volume simulation, but it splits attention across more than one live offer.' }],
    priceCategories: [{ size: 'Standard', price: 108, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,1,1' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 80, totalInventory: 80, winnerTiers: [2, 1, 1], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p12', name: 'Quartz Ember — Live FCFS', slug: 'quartz-ember-live-fcfs', prefix: 'obsidian-void', tagline: 'FCFS / LIVE', desc: 'Additional direct buy listing to stress-test cart and checkout UX.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 11,
    notes: [{ label: 'MODE', name: 'Cart stress test', text: 'Demonstrates how direct items can stack into a cart for higher order value.' }, { label: 'TRADEOFF', name: 'Pros / cons', text: 'Best for repeat buyers and bundles, but less selective than a prestige draw.' }],
    priceCategories: [{ size: 'Standard', price: 152, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 3, maxPerCart: 3, maxRaffleAllocationLimit: 0, totalInventory: 180, winnerTiers: [0], soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 24, createdAt: NOW, updatedAt: NOW,
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
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';
    const master = getAdminPassword() || '';

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