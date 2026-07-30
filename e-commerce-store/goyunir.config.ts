import { buildStorefrontConfig } from './lib/storefront-config';

// ============================================================
// GOYUNIR CONFIG — THE ONLY FILE YOU SHOULD EVER NEED TO TOUCH
// ============================================================
// Everything about products, pricing, drop timing, and site copy lives
// here. You should never need to open any other code file to run the
// site day to day.
//
// TIMEZONE: All times below are in the timezone you set (default: PST /
// "America/Los_Angeles"). You can change it once here and every countdown
// updates automatically.
//
// IMPORTANT — the automatic charge cron in vercel.json runs on Vercel's
// servers, which only understand UTC, not PST. If you change the draw
// time below, you must ALSO update the "schedule" line in vercel.json to
// the matching UTC hour (see README.md for the conversion table).
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

  // ============================================================
  // GLOBAL DROP SCHEDULE — applies to every product UNLESS that product
  // has its own "customDropSchedule" set (see the product examples below).
  // ============================================================
  dropSchedule: {
    mode: 'weekly',                    // 'weekly' repeats forever. 'fixed' uses one exact date/time below.
    timezone: 'America/Los_Angeles',   // Change to your timezone, e.g. 'America/New_York', 'Europe/London'.
    targetEndDateTime: '2026-07-27T19:30:00', // only used when mode is 'fixed'
    drawDayOfWeek: 6,                  // 0=Sunday, 1=Monday, 2=Tuesday, 3=Wed, 4=Thu, 5=Fri, 6=Saturday
    drawHour: 21,                      // 0-23, local to the timezone above (21 = 9:00 PM)
    drawMinute: 0,
    countdownExpiredText: 'ALLOCATION. CLOSED • VARIANT ARCHIVED',
    daysLabel: 'd', hoursLabel: 'h', minutesLabel: 'm', secondsLabel: 's',
    winnersPer50ml: 10,                // how many 50ml winners get picked and charged each drop
    winnersPer100ml: 5,                // how many 100ml winners get picked and charged each drop
  },

  // ============================================================
  // BOTTLE ANIMATION
  // totalFramesToLoad: how many rotation photos you have. Name your image
  // files PREFIX_1.jpg through PREFIX_N.jpg in /public/images/ (PREFIX is
  // set per-product below). Use 30-60 for a smooth spin.
  // spinCyclesTopToCheckout: how many full spins happen while someone
  // scrolls from the top of the page down to the entry form. Raise this
  // number to make the bottle spin faster/more.
  // ============================================================
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

  // ============================================================
  // SOCIAL PROOF COUNTER ("X people entered")
  // baseCount: your honest starting floor number. Real confirmed entries
  // are added to this automatically and always accurately.
  // autoIncrementEnabled: turn on/off a small extra "organic looking"
  // number that ticks up on its own from real visitor activity, purely
  // for hype. Set to false any time for 100% real numbers only.
  // Resets to baseCount automatically after every draw.
  // ============================================================
  socialProof: {
    label: 'Limited drop access',
    baseCount: 0,
    caption: 'Hype is compounding fast—reserve now before inventory closes.',
    autoIncrementEnabled: true,
    autoIncrementChancePerHeartbeat: 0.15, // 0 = never, 1 = every single heartbeat (~every 25s per visitor)
    autoIncrementAmount: 1,
  },

  brandFooterData: {
    instagramLink: 'https://instagram.com/goyunir',
    tiktokLink: 'https://tiktok.com/goyunir',
    supportEmail: 'goyunir.support@gmail.com',
    shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
    corporateEntityCopyright: 'GOYUNIR ALL RIGHTS RESERVED.',
  },

  // ============================================================
  // CATALOG PAGE — CLOTHING / UPCOMING ITEMS (not raffled, just shown)
  // Shows up as tappable tiles on the /catalog page automatically.
  // image: path under /public/images/. Leave off for a placeholder tile.
  // ============================================================
  catalogPreview: {
    upcomingDrops: [
      { name: 'GOYUNIR Heavyweight Tee — Vol. 1', status: 'Upcoming', eta: 'Late 2026', image: '/images/tee-vol1.jpg', description: 'A heavyweight cotton tee with a raised GOYUNIR emblem across the chest.' },
      { name: 'Raw Weave Cargo', status: 'Upcoming', eta: 'Late 2026', image: '/images/cargo.jpg', description: 'Utility-inspired cargo pants in raw, undyed cotton canvas.' },
    ],
    archiveScents: [
      { name: 'Crimson Static', status: 'Archived', image: '/images/crimson-static.jpg', description: 'A discontinued profile built around raw saffron and dark cassis.' },
    ],
  },

  // ============================================================
  // PRODUCTS — YOUR RAFFLED PERFUMES
  // Copy an entire { ... } block below to add a new perfume.
  //
  // REQUIRED FIELDS:
  //   id             — unique short code, never reuse an old one, e.g. 'p3'
  //   name           — display name
  //   slug           — used in the share link, e.g. 'elysian-white' becomes
  //                    yoursite.com/elysian-white — lowercase, no spaces
  //   prefix         — must match your image files: PREFIX_1.jpg ... PREFIX_N.jpg
  //   stripeId50ml / stripeId100ml — real Stripe Price IDs from your Stripe Dashboard
  //   isActive       — false hides it from the site entirely (no deploy-free
  //                    toggle for this one — for LIVE archive/unarchive
  //                    without a deploy, use the Admin Portal instead)
  //
  // OPTIONAL FIELDS (safe to delete if you don't need them):
  //   customDropSchedule       — gives THIS product its own countdown,
  //                              independent of the global one above.
  //                              Only include the fields you want to
  //                              override; anything you omit uses the
  //                              global dropSchedule.
  //   scheduledArchiveAt       — 'YYYY-MM-DDTHH:MM:SS' wall-clock time
  //                              (in the schedule's timezone). When this
  //                              time passes, the product automatically
  //                              moves to the Catalog page's archive —
  //                              no admin action needed.
  //   scheduledUnarchiveAt     — same format. When this time passes, an
  //                              archived product automatically comes back
  //                              as an active, enterable drop.
  //   catalogImage             — image shown once this product is archived
  //                              onto the /catalog page.
  // ============================================================
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
      // Example: this product draws every Saturday at 9pm PST (uses the
      // global schedule above, no override needed) — this block is left
      // here commented as a template for when you want a DIFFERENT time
      // for just this one product:
      // customDropSchedule: { drawDayOfWeek: 5, drawHour: 18, drawMinute: 30 },
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