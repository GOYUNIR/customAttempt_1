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

  // ONLY size(s) shown on the form. Add '100ml' later when ready:
  // availableSizes: ['50ml', '100ml'],
  availableSizes: ['50ml'],

  dropSchedule: {
    mode: 'fixed',//weekly/fixed
    timezone: 'America/Los_Angeles',
    targetEndDateTime: '2026-07-31T2:20:00',
    drawDayOfWeek: 6,
    drawHour: 21,
    drawMinute: 0,
    countdownExpiredText: 'ALLOCATION. CLOSED • VARIANT ARCHIVED',
    daysLabel: 'd', hoursLabel: 'h', minutesLabel: 'm', secondsLabel: 's',
    winnersPer50ml: 10,
    winnersPer100ml: 5,
  },

  animationMechanics: {
    totalFramesToLoad: 4,
    maxRotationDegrees: 360,
    spinReverseOnAlternatingProgress: true,
    spinCyclesTopToCheckout: 6,
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
      { name: 'GOYUNIR Heavyweight Tee — Vol. 1', status: 'Upcoming', eta: 'Late 2026', image: '/images/tee-vol1.jpg', description: 'A heavyweight cotton tee with a raised GOYUNIR emblem across the chest.' },
      { name: 'Raw Weave Cargo', status: 'Upcoming', eta: 'Late 2026', image: '/images/cargo.jpg', description: 'Utility-inspired cargo pants in raw, undyed cotton canvas.' },
    ],
    archiveScents: [
      { name: 'Crimson Static', status: 'Archived', image: '/images/crimson-static.jpg', description: 'A discontinued profile built around raw saffron and dark cassis.' },
    ],
  },

  productCatalog: [
    {
      id: 'p1',
      name: 'Elysian White',
      slug: 'elysian-white',
      prefix: 'EXAMPLEPICV1',
      tagline: 'WHITE ALLOCATION / 01',
      desc: 'Clean, electric profile variant constructed with premium bergamot.',
      price50ml: 85,
      price100ml: 140,
      stripeId50ml: 'price_1TxGXQPIsR6ijfBZUKefFNOI',
      stripeId100ml: 'price_1Txn9YPIsR6ijfBZJZhSdHEr',
      maxRaffleAllocationLimit: 10,
      isActive: true,
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
      prefix: 'EXAMPLEPICV2',
      tagline: 'BLACK ALLOCATION / 02',
      desc: 'Deep, smoke-infused wood profile variant designed for lasting depth.',
      price50ml: 85,
      price100ml: 140,
      stripeId50ml: 'price_1TxnJ3PIsR6ijfBZUFXVhIfF',
      stripeId100ml: 'price_1TxnJpPIsR6ijfBZVvlrffeO',
      maxRaffleAllocationLimit: 5,
      isActive: true,
      notes: [
        { label: 'TOP PROFILE', name: 'Midnight Spice', text: 'A dark sensory introduction of clove and rare cardamom.' },
        { label: 'HEART PROFILE', name: 'Obsidian Amber', text: 'Midnight jasmine absolute bleeding into raw vetiver roots.' },
        { label: 'BASE PROFILE', name: 'Earthy Timber', text: 'A rich cedarwood base that deepens as the hours develop.' },
      ],
    },
  ],
});