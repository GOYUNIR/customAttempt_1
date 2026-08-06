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

  // Default size – change via /admin → Settings
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

  productCatalog: [
    {
      id: 'p1',
      name: 'Elysian White',
      slug: 'elysian-white',
      prefix: 'elysian-white',
      tagline: 'WHITE ALLOCATION / 01',
      desc: 'Clean, electric profile variant constructed with premium bergamot.',
      price50ml: 0,          // neutral – set real price in admin
      price100ml: 0,
      stripeId50ml: 'price_1U1MD0PIsR6ijfBZ872i58N1',
      stripeId100ml: 'price_1U1MD0PIsR6ijfBZ872i58N1',
      maxRaffleAllocationLimit: 0,
      isActive: true,
      totalInventory: 0,
      winnerTiers: [0],
      notes: [
        { label: 'TOP PROFILE', name: 'White Bergamot', text: 'Crisp Sicilian bergamot crushed with volcanic pink pepper.' },
        { label: 'HEART PROFILE', name: 'Citrus Flash', text: 'Fresh, electric burst optimized to capture immediate attention.' },
        { label: 'BASE PROFILE', name: 'Clean Musk', text: 'A smooth velvet finish that lingers delicately on fabrics.' },
      ],
    },
    {
      id: 'p2',
      name: 'Obsidian Void',
      slug: 'obsidian-void',
      prefix: 'obsidian-void',
      tagline: 'BLACK ALLOCATION / 02',
      desc: 'Deep, smoke-infused wood profile variant designed for lasting depth.',
      price50ml: 0,
      price100ml: 0,
      stripeId50ml: 'price_1U1MD0PIsR6ijfBZ872i58N1',
      stripeId100ml: 'price_1U1MD0PIsR6ijfBZ872i58N1',
      maxRaffleAllocationLimit: 0,
      isActive: true,
      totalInventory: 0,
      winnerTiers: [0],
      notes: [
        { label: 'TOP PROFILE', name: 'Midnight Spice', text: 'A dark sensory introduction of clove and rare cardamom.' },
        { label: 'HEART PROFILE', name: 'Obsidian Amber', text: 'Midnight jasmine absolute bleeding into raw vetiver roots.' },
        { label: 'BASE PROFILE', name: 'Earthy Timber', text: 'A rich cedarwood base that deepens as the hours develop.' },
      ],
    },
  ],
});