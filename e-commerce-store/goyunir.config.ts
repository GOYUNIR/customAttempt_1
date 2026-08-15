import { buildStorefrontConfig } from './lib/storefront-config';

export const GOYUNIR_STORE_SUITE = buildStorefrontConfig({
  themeColors: {
    primaryBackground: '#f5f5f7',
    cardBackground: '#ffffff',
    cardBorder: 'rgba(0,0,0,0.08)',
    accentPurple: '#af52de',
    accentBlue: '#0071e3',
    textMain: '#1d1d1f',
    textMuted: '#6e6e73',
    cardTextMain: '#1d1d1f',
    cardTextMuted: '#6e6e73',
    checkoutCtaButton: '#0071e3',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    borderRadius: 22,
    // Transparency (0-100): chrome = header/footer/drawer, surface = cards.
    chromeTransparency: 70,
    surfaceTransparency: 100,
    // Apple design-language defaults: squircle corners, soft low-intensity card
    // shadows, and a subtle frosted-glass backdrop for the chrome surfaces.
    radiusStyle: 'squircle',
    cardShadow: 12,
    backdropBlur: 55,
    contentSpacing: 'comfortable',
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
    upcomingDrops: [
      {
        name: 'Signature Heavyweight Tee — Vol. 1',
        status: 'Upcoming',
        eta: 'Late 2026',
        image: '/images/tee-vol1/1.jpeg',
        description: 'A heavyweight cotton tee with a raised emblem across the chest. This is early — expect this category to take a while before anything ships.',
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

  // Glow orb system (editable live from /admin → Settings → Orb Glow).
  // Background glow orbs behind the storefront content. The old top-bar orb
  // has been removed in favor of more (smaller, subtler) background orbs.
  orbs: {
    enabled: true,
    primary: { enabled: true, color: '#3b82f6', opacity: 16, size: 58 },
    secondary: { enabled: true, color: '#a855f7', opacity: 26, size: 44 },
    tertiary: { enabled: true, color: '#ffd79b', opacity: 12, size: 28 },
    fourth: { enabled: true, color: '#7dd3fc', opacity: 10, size: 36 },
    fifth: { enabled: true, color: '#f472b6', opacity: 8, size: 24 },
    motion: {
      idleEnabled: true,
      pointerEnabled: true,
      scrollEnabled: true,
      intensity: 100,
      speed: 100,
      momentum: 40,
    },
  },

  // NOTE: This productCatalog is a STATIC CONFIG used only for catalog preview,
  // cron/draw metadata, and admin read helpers. It is NOT served to the
  // storefront — when Redis is empty the store shows 0 items. Stripe IDs are
  // intentionally blank here; they are resolved at seed/checkout time from the
  // STRIPE_PRODUCT_ID env var or the per-product values set in /admin.
  productCatalog: [
    {
      id: 'p1',
      name: 'Elysian White — Launch Draw',
      slug: 'elysian-white-launch-draw',
      prefix: 'elysian-white',
      tagline: 'RAFFLE / LIVE',
      desc: 'Primary hero raffle drop with tight allocation.',
      priceCategories: [
        { size: 'Standard', price: 95, stripeId: '', winnerTiers: '3,2,2' }
      ],
      notes: [
        { label: 'MODE', name: 'Live raffle', text: 'Best for manufactured scarcity, waitlist growth, and careful winner selection.' },
      ],
      images: ['/images/elysian-white/1.jpeg'],
      maxRaffleAllocationLimit: 120,
      totalInventory: 120,
      winnerTiers: [3, 2, 2],
      isActive: true,
      isRaffle: true,
      checkoutMode: 'RAFFLE',
      productType: 'raffle',
    },
    {
      id: 'p2',
      name: 'Obsidian Void — Priority Draw',
      slug: 'obsidian-void-priority-draw',
      prefix: 'obsidian-void',
      tagline: 'RAFFLE / LIVE',
      desc: 'High-intent raffle queue with limited winners.',
      priceCategories: [
        { size: 'Standard', price: 110, stripeId: '', winnerTiers: '2,2,1' }
      ],
      notes: [
        { label: 'MODE', name: 'Priority raffle', text: 'Useful when a client wants social buzz without opening unlimited direct checkout.' },
      ],
      images: ['/images/obsidian-void/1.jpeg'],
      maxRaffleAllocationLimit: 90,
      totalInventory: 90,
      winnerTiers: [2, 2, 1],
      isActive: true,
      isRaffle: true,
      checkoutMode: 'RAFFLE',
      productType: 'raffle',
    },
    {
      id: 'p3',
      name: 'Noir Citrus — Instant Drop',
      slug: 'noir-citrus-instant-drop',
      prefix: 'baseItem1',
      tagline: 'FCFS / LIVE',
      desc: 'Fast-checkout direct buy drop for cart flow.',
      priceCategories: [
        { size: 'Sampler Set', price: 19, stripeId: '', winnerTiers: '0' },
        { size: 'Full Bottle', price: 145, stripeId: '', winnerTiers: '0' },
      ],
      notes: [
        { label: 'MODE', name: 'Live FCFS', text: 'Best for immediate conversion from social clicks and high-speed product demand.' },
      ],
      images: ['/images/baseItem1/1.jpeg'],
      maxRaffleAllocationLimit: 0,
      totalInventory: 160,
      winnerTiers: [0],
      isActive: true,
      isRaffle: false,
      checkoutMode: 'FCFS',
      productType: 'checkout',
    },
  ] as any[], // cast to any to allow extra fields not in StorefrontProduct
});