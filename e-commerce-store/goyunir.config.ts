import { buildStorefrontConfig } from './lib/storefront-config';

export const GOYUNIR_STORE_SUITE = buildStorefrontConfig({
  themeColors: {
    primaryBackground: '#f5f5f7',
    cardBackground: '#ffffff',
    cardBorder: 'rgba(0,0,0,0.14)',
    accentPurple: '#af52de',
    accentBlue: '#0071e3',
    textMain: '#1d1d1f',
    textMuted: '#52525a',
    cardTextMain: '#1d1d1f',
    cardTextMuted: '#52525a',
    checkoutCtaButton: '#0071e3',
    // Top bar colors — empty = auto (derived from cardBackground + chrome alpha).
    headerBackground: '',
    headerText: '',
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
    customIntervalHours: 24,
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
    eyebrow: 'CALIFORNIA USA',
    headline: 'by our hands. to your hands.',
    body: 'homemade & designed, with real ingredients, with real hands. for real people.',
    ctaLabel: 'Browse drops',
    storyHeadline: 'Our Story',
    storyBody: 'take control.',
  },

  socialProof: {
    label: 'Limited drop access',
    baseCount: 0,
    caption: 'Hype is compounding fast—reserve now before inventory closes.',
    autoIncrementEnabled: true,
    autoIncrementChancePerHeartbeat: 0.18,
    autoIncrementAmount: 2,
    autoIncrementMaxPerDay: 15,
    autoIncrementMinHourGap: 1,
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
      {
        name: 'Solar Drift — Upcoming FCFS',
        status: 'Upcoming',
        eta: 'Soon',
        image: '/images/baseItem1/2.jpeg',
        description: 'Direct-purchase drop entering the queue — a bright, immediate FCFS release.',
        slug: 'solar-drift-upcoming-fcfs',
      },
    ],
    archiveScents: [
      {
        name: 'Crimson Static',
        status: 'Archived',
        image: '/images/crimson-static/1.jpeg',
        description: 'A discontinued profile built around raw saffron and dark cassis.',
      },
      {
        name: 'Atlas Bloom — Archive',
        status: 'Archived',
        image: '/images/baseItem2/1.jpeg',
        description: 'Completed direct drop preserved in the archive lane.',
        slug: 'atlas-bloom-archive',
      },
    ],
  },

  // Catalog presentation settings (admin → Settings → Catalog). Section order
  // defaults to live at the BOTTOM; `categories` is the seeded admin-managed
  // list buyers can add/rename/delete — products are tagged with any subset.
  catalog: {
    sectionOrder: ['upcoming', 'archive', 'live'],
    categories: ['Perfume', 'Clothes', 'Shoes', 'Food', 'Tools', 'Tires', 'Pastries', 'Beanies', 'Winter', 'Summer', 'Men', 'Unisex', 'Women'],
  },

  // Checkout & orders policy (admin → Settings → Checkout & Orders). When ON
  // (default) customer "update address" flows require the full Mapbox-dropdown
  // address; the admin portal can override and save a partial address.
  checkout: {
    requireAddressAutofill: true,
  },

  // Glow orb system (editable live from /admin → Settings → Orb Glow).
  // Background glow orbs behind the storefront content. Opacities stay LOW on
  // purpose — the glow is an ambient wash, not a blob. The top-bar orb and the
  // cart-drawer orbs were removed (see the changelog).
  orbs: {
    enabled: true,
    primary: { enabled: true, color: '#3b82f6', opacity: 12, size: 58 },
    secondary: { enabled: true, color: '#a855f7', opacity: 15, size: 44 },
    tertiary: { enabled: true, color: '#ffd79b', opacity: 8, size: 28 },
    fourth: { enabled: true, color: '#7dd3fc', opacity: 8, size: 36 },
    fifth: { enabled: true, color: '#f472b6', opacity: 6, size: 24 },
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
      images: ['/images/elysian-white/1.jpeg', '/images/elysian-white/2.jpeg', '/images/elysian-white/3.jpeg'],
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
      images: ['/images/obsidian-void/1.jpeg', '/images/obsidian-void/2.jpeg', '/images/obsidian-void/3.jpeg'],
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
      tagline: 'MIXED / LIVE',
      desc: 'A single release, two ways to buy: the Sampler Set sells instantly (FCFS) while the Full Bottle runs a raffle.',
      priceCategories: [
        { size: 'Sampler Set', price: 19, stripeId: '', winnerTiers: '0', checkoutMode: 'FCFS' },
        { size: 'Full Bottle', price: 145, stripeId: '', winnerTiers: '2,2', checkoutMode: 'RAFFLE' },
      ],
      samplerSizes: [
        {
          size: 'Sampler Set',
          label: 'Trial',
          fullSize: 'Full Bottle',
          creditCents: 1500,
          minOrderSubtotalCents: 9000,
          neverExpires: false,
          expiresDays: 60,
          codePrefix: 'NOIR',
          eligibleProductSlugs: ['noir-citrus-instant-drop'],
          eligibleSizes: ['Full Bottle'],
          note: 'The 19ml trial is the same juice in a smaller bottle — fall in love with it first, then upgrade.',
        },
      ],
      notes: [
        { label: 'MODE', name: 'Live FCFS', text: 'Best for immediate conversion from social clicks and high-speed product demand.' },
      ],
      images: ['/images/baseItem1/1.jpeg', '/images/baseItem1/2.jpeg', '/images/baseItem1/3.jpeg'],
      maxRaffleAllocationLimit: 0,
      totalInventory: 160,
      winnerTiers: [0],
      isActive: true,
      isRaffle: true,
      checkoutMode: 'RAFFLE',
      productType: 'raffle',
    },
  ] as any[], // cast to any to allow extra fields not in StorefrontProduct
});