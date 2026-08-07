import { buildStorefrontConfig } from './lib/storefront-config';

export const GOYUNIR_STORE_SUITE = buildStorefrontConfig({
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

  dropSchedule: {
    mode: 'daily',
    timezone: 'America/Los_Angeles',
    targetEndDateTime: '2026-08-01T01:20:00',
    drawDayOfWeek: 6,
    drawDayOfMonth: 1,
    drawHour: 0,
    drawMinute: 0,
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
    body: 'We design fragrances that move faster than time itself. An intentional collision of raw natural essences and electric modern chemistry.',
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
      {
        name: 'GOYUNIR Heavyweight Tee — Vol. 1',
        status: 'Upcoming',
        eta: 'Late 2026',
        image: '/images/tee-vol1/1.jpeg',
        description: 'A heavyweight cotton tee with a raised GOYUNIR emblem across the chest. This is early — expect this category to take a while before anything ships.',
      },
      {
        name: 'Raw Weave Cargo',
        status: 'Upcoming',
        eta: 'Late 2026',
        image: '/images/cargo/1.jpeg',
        description: 'Utility-inspired cargo pants in raw, undyed cotton canvas. Still in development, no firm date yet.',
      },
    ],
    archiveScents: [
      {
        name: 'Crimson Static',
        status: 'Archived',
        image: '/images/crimson-static/1.jpeg',
        description: 'A discontinued profile built around raw saffron and dark cassis.',
      },
    ],
  },

  // NOTE: The type StorefrontProduct expects price50ml/100ml, but we override with priceCategories.
  // We cast as any to bypass type errors – these fields are used in Redis, not here.
  productCatalog: [
    {
      id: 'p1',
      name: 'Drop 01 — Raffle Access',
      slug: 'drop-01-raffle-access',
      prefix: 'drop-01',
      tagline: 'LIMITED Raffle / 01',
      desc: 'A premium release designed for raffle entry and controlled allocation.',
      priceCategories: [
        { size: 'Standard', price: 95, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '2,2,1' }
      ],
      notes: [
        { label: 'DROP', name: 'Raffle Access', text: 'Entry is limited and managed through the admin-controlled draw system.' },
      ],
      images: ['/images/baseItem1/1.jpeg'],
      maxRaffleAllocationLimit: 100,
      totalInventory: 100,
      winnerTiers: [2, 2, 1],
      isActive: true,
      isRaffle: true,
      productType: 'raffle',
    },
    {
      id: 'p2',
      name: 'Drop 02 — Direct Buy',
      slug: 'drop-02-direct-buy',
      prefix: 'drop-02',
      tagline: 'DIRECT BUY / 02',
      desc: 'A ready-to-purchase release for immediate checkout and cart fulfillment.',
      priceCategories: [
        { size: 'Standard', price: 145, stripeId: 'price_1U1MD0PIsR6ijfBZ872i58N1', winnerTiers: '0' }
      ],
      notes: [
        { label: 'BUY NOW', name: 'Instant Checkout', text: 'This item can be purchased immediately and added to cart.' },
      ],
      images: ['/images/baseItem2/1.jpeg'],
      maxRaffleAllocationLimit: 0,
      totalInventory: 120,
      winnerTiers: [0],
      isActive: true,
      isRaffle: false,
      productType: 'checkout',
    },
  ] as any[], // cast to any to allow extra fields not in StorefrontProduct
});