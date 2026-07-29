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

  // ============================================
  // DROP SCHEDULE
  // mode: 'weekly' auto-repeats every week at the day/time below (great for
  // a 52-week / 13-per-week cadence). mode: 'fixed' uses one exact date —
  // switch to this for special one-off drops.
  // IMPORTANT: this must match the cron schedule in vercel.json, or the
  // countdown and the actual auto-charge will disagree.
  // ============================================
  dropSchedule: {
    mode: 'weekly',
    targetEndDateTime: '2026-07-27T19:30:00', // only used when mode is 'fixed'
    drawDayOfWeekUTC: 6, // Saturday
    drawHourUTC: 4, // 4:00 UTC — adjust to your audience's local midnight
    drawMinuteUTC: 0,
    countdownExpiredText: 'ALLOCATION. CLOSED • VARIANT ARCHIVED',
    daysLabel: 'd',
    hoursLabel: 'h',
    minutesLabel: 'm',
    secondsLabel: 's',
    winnersPer50ml: 10,
    winnersPer100ml: 5,
  },

  animationMechanics: {
    totalFramesToLoad: 4, // bump to 30-60 for production, matching your image count
    maxRotationDegrees: 360,
    spinReverseOnAlternatingProgress: true,
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

  // ============================================
  // SOCIAL PROOF
  // baseCount: your honest floor number. Real confirmed entries add on top
  // automatically. autoIncrementEnabled adds small organic-looking ticks
  // from real visitor activity — set to false any time for pure real numbers.
  // Resets to baseCount after every draw automatically.
  // ============================================
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

  // ============================================
  // CATALOG PAGE CONTENT
  // Shows up automatically on the /catalog page as tappable tiles.
  // image: path under /public/images/. Leave blank for a placeholder tile.
  // ============================================
  catalogPreview: {
    upcomingDrops: [
      { name: 'GOYUNIR Heavyweight Tee — Vol. 1', status: 'Upcoming', eta: 'Late 2026', image: '/images/tee-vol1.jpg', description: 'A heavyweight cotton tee with a raised GOYUNIR emblem across the chest.' },
      { name: 'Raw Weave Cargo', status: 'Upcoming', eta: 'Late 2026', image: '/images/cargo.jpg', description: 'Utility-inspired cargo pants in raw, undyed cotton canvas.' },
    ],
    archiveScents: [
      { name: 'Crimson Static', status: 'Archived', image: '/images/crimson-static.jpg', description: 'A discontinued profile built around raw saffron and dark cassis.' },
      { name: 'Glass Amber', status: 'Archived', image: '/images/glass-amber.jpg', description: 'A transparent, resinous amber note with a cold mineral finish.' },
    ],
  },

  // ============================================
  // PRODUCTS
  // Copy an existing block below to add a new perfume.
  // `prefix` must match image files in /public/images/ named
  // PREFIX_1.jpg through PREFIX_N.jpg (N = totalFramesToLoad above).
  // `stripeId50ml` / `stripeId100ml` must be real Stripe Price IDs.
  // ============================================
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