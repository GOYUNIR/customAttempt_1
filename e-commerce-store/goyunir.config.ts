import { buildStorefrontConfig } from './lib/storefront-config';

// ============================================================
// GOYUNIR CONFIG — THE ONLY FILE YOU SHOULD EVER NEED TO TOUCH
// ============================================================
// IMPORTANT: this file is baked into the site at BUILD time. After
// editing anything here, you must commit + push so Vercel redeploys —
// just saving the file locally does nothing to the live site.
//
// IMPORTANT #2 — INVENTORY / ACTIVE / WINNER TIERS: `totalInventory`,
// `winnerTiers`, and `isActive` below are SEED VALUES ONLY. The first
// time a product/size is seen, these values are copied into Redis, and
// from then on Redis is the source of truth. Once a product has sold
// through some inventory, editing the numbers here and redeploying will
// NOT reset it back — use the Admin Portal (/admin) to change inventory,
// active/hidden status, or winner tiers on a live product.
// ============================================================

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

  // ============================================================
  // HOME_REDIRECT_SLUG — optional. Pins "/" to always land on ONE specific
  // product (must match a `slug` below exactly). Leave commented out to
  // always land on the first active, non-archived product instead. If
  // nothing is active/available, "/" always falls back to "/catalog".
  // ============================================================
  // homeRedirectSlug: 'elysian-white',

  // ============================================================
  // DROP SCHEDULE — four modes, pick ONE:
  //
  //   mode: 'fixed'   — one exact date/time (targetEndDateTime below).
  //                     Format MUST be: YYYY-MM-DDTHH:MM:SS
  //                     (24-hour clock, always 2 digits — "09" not "9").
  //                     Example: '2026-07-31T21:00:00' = July 31, 9:00 PM.
  //                     NOTE: if this date is already in the past, the
  //                     countdown will correctly show as CLOSED — that's
  //                     not a bug, just make sure the date is in the future.
  //
  //   mode: 'daily'   — repeats every day at the same time. Set drawHour,
  //                     drawMinute.
  //
  //   mode: 'weekly'  — repeats forever on the same day-of-week/time.
  //                     Set drawDayOfWeek (0=Sun...6=Sat), drawHour,
  //                     drawMinute.
  //
  //   mode: 'monthly' — repeats forever on the same day-of-month/time.
  //                     Set drawDayOfMonth (1-31), drawHour, drawMinute.
  //                     If a month is shorter than the day you picked
  //                     (e.g. drawDayOfMonth: 31 in February), it
  //                     automatically uses that month's last real day.
  //
  // `timezone` applies to ALL four modes — change it once here.
  // ============================================================
  dropSchedule: {
    mode: 'daily',
    timezone: 'America/Los_Angeles',
    targetEndDateTime: '2026-08-01T01:20:00',
    drawDayOfWeek: 6,   // only used in 'weekly' mode
    drawDayOfMonth: 1,  // only used in 'monthly' mode
    drawHour: 0,       // only used in 'daily' / 'weekly' / 'monthly' modes
    drawMinute: 0,
    countdownExpiredText: 'ALLOCATION. CLOSED • VARIANT ARCHIVED',
    daysLabel: 'd', hoursLabel: 'h', minutesLabel: 'm', secondsLabel: 's',
    // SEED-ONLY fallback winner counts, used only if a product below
    // doesn't specify its own `winnerTiers`. Edit live values in /admin.
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
    // This is the combined "real + artificial" hype number. As real
    // winners get charged, that many are automatically SUBTRACTED from
    // this number when it's displayed (see lib/server-config.ts).
    baseCount: 0,
    caption: 'Hype is compounding fast—reserve now before inventory closes.',
    autoIncrementEnabled: true,
    autoIncrementChancePerHeartbeat: 0.15,
    autoIncrementAmount: 1,
    // "randomly go up X times a day, X hour threshold" controls:
    autoIncrementMaxPerDay: 4,   // ticks up at most this many times per day
    autoIncrementMinHourGap: 3,  // waits at least this many hours between ticks
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
        image: '/images/tee-vol1.jpg',
        // This description shows in the catalog tap-through — use it to
        // set expectations on timing for stuff that's a while out:
        description: 'A heavyweight cotton tee with a raised GOYUNIR emblem across the chest. This is early — expect this category to take a while before anything ships.',
      },
      { name: 'Raw Weave Cargo', status: 'Upcoming', eta: 'Late 2026', image: '/images/cargo.jpg', description: 'Utility-inspired cargo pants in raw, undyed cotton canvas. Still in development, no firm date yet.' },
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
      // SEED-ONLY: starts with 9 total units, draws 2 winners/round for the
      // first 4 rounds, then 1 for the 5th round (2+2+2+2+1=9, hits 0
      // exactly, then auto-archives). Edit live via /admin after this seeds.
      totalInventory: 9,
      winnerTiers: [2, 2, 2, 2, 1],
      notes: [
        { label: 'TOP PROFILE', name: 'White Bergamot', text: 'Crisp Sicilian bergamot crushed with volcanic pink pepper.' },
        { label: 'HEART PROFILE', name: 'Citrus Flash', text: 'Fresh, electric burst optimized to capture immediate attention.' },
        { label: 'BASE PROFILE', name: 'Clean Musk', text: 'A smooth velvet finish that lingers delicately on fabrics.' },
      ],
      // Example: this product could use its own schedule instead of the
      // global one above — only include the fields you want to override:
      // customDropSchedule: { mode: 'monthly', drawDayOfMonth: 15 },
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
      totalInventory: 5,
      winnerTiers: [1],
      notes: [
        { label: 'TOP PROFILE', name: 'Midnight Spice', text: 'A dark sensory introduction of clove and rare cardamom.' },
        { label: 'HEART PROFILE', name: 'Obsidian Amber', text: 'Midnight jasmine absolute bleeding into raw vetiver roots.' },
        { label: 'BASE PROFILE', name: 'Earthy Timber', text: 'A rich cedarwood base that deepens as the hours develop.' },
      ],
    },
  ],
});