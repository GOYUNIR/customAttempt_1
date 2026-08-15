import { NextResponse } from 'next/server';
import { createRedisClient, adminRequestAuthorized, defaultStripePriceId, getLiveProductState, PRODUCTS_KEY, STORE_CONFIG_KEY} from '@/lib/server-config';
import { appendAudit } from '@/app/api/admin/audit/route';
import { DEFAULT_LEGAL } from '@/lib/legal-config';

export const dynamic = 'force-dynamic';

// Single source of truth: products live ONLY in `store:products`. The
// storefront derives active/archived/upcoming by filtering these flags at read
// time (see /api/store and /api/catalog/status), so no mirror hashes exist.

// Seeded products – now using priceCategories, no price50ml/100ml.
const NOW = new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const isoIn = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19);
const DEFAULT_PRODUCTS = [
  {
    id: 'p1', name: 'Elysian White — Launch Draw', slug: 'elysian-white-launch-draw', prefix: 'elysian-white', tagline: 'RAFFLE / LIVE', desc: 'The hero launch — a bright amber-white composition with the tightest allocation of the season.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 0,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'Every entry is a pre-commitment: you lock shipping + payment, then a draw picks winners per size tier. Unselected entries are released automatically — nothing is charged silently.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'This is the flagship. It shows how a hero product builds a waitlist, carries promoter links, and creates private-club energy that makes a launch feel scarce without overselling.' },
      { label: 'PROS', name: 'Pros', text: 'Feels exclusive and fair, gives a clean waitlist, and keeps the charge decision in the customer’s hands until the draw runs.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Conversion is deferred — customers commit first and pay later, so instant revenue is lower than a direct FCFS drop.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Manufactured scarcity, email capture, and careful winner selection on a marquee product.' },
    ],
    priceCategories: [{ size: 'Standard', price: 95, stripeId: defaultStripePriceId(), winnerTiers: '3,2,2' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 120, totalInventory: 120, winnerTiers: [3, 2, 2], releaseEndsAt: isoIn(2 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 48, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p2', name: 'Obsidian Void — Priority Draw', slug: 'obsidian-void-priority-draw', prefix: 'obsidian-void', tagline: 'RAFFLE / LIVE', desc: 'High-intent raffle queue with a deliberately small winner list.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 1,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'A priority draw: fewer winners, higher stakes. Entry locks the customer in, and the draw rewards a small pool of selected collectors.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Demonstrates the “tiered winner” mechanic (3 winners → 2 → 1) and shows clients how a two-product launch can split traffic between hero and secondary items.' },
      { label: 'PROS', name: 'Pros', text: 'Excellent for social buzz and promoter traffic without opening unlimited direct checkout.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Lower instant revenue than FCFS and a higher chance customers feel “waitlisted” if the pool overfills.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'VIP / early-access releases where exclusivity is the whole point.' },
    ],
    priceCategories: [{ size: 'Standard', price: 110, stripeId: defaultStripePriceId(), winnerTiers: '2,2,1' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 90, totalInventory: 90, winnerTiers: [2, 2, 1], releaseEndsAt: isoIn(3 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 72, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p3', name: 'Noir Citrus — Instant Drop', slug: 'noir-citrus-instant-drop', prefix: 'baseItem1', tagline: 'FCFS / LIVE', desc: 'Fast-checkout direct buy drop that demos the cart, bundles, and a sample-to-full-size incentive.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 2,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'First-come, first-served. Customers add sizes to the cart and pay immediately — no draw, no waiting.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'This product demos the cart flow, multi-size pricing (Sampler vs Full Bottle), and the delivery incentive: buying the sampler credits you toward the full size.' },
      { label: 'PROS', name: 'Pros', text: 'Fastest checkout path, immediate revenue, and perfect for social-driven traffic.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Can sell through instantly and skips the anticipation of a draw.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Immediate conversion from social clicks, bundles, and upselling a cheap entry into a full purchase.' },
    ],
    priceCategories: [{ size: 'Sampler Set', price: 19, stripeId: defaultStripePriceId(), winnerTiers: '0' }, { size: 'Full Bottle', price: 145, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 160, winnerTiers: [0], soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 24, deliveryIncentiveEnabled: true, deliveryIncentiveCreditCents: 1500, deliveryIncentiveMinOrderSubtotalCents: 9000, deliveryIncentiveExpiresDays: 60, deliveryIncentiveCodePrefix: 'NOIR', deliveryIncentiveTriggerSizes: ['Sampler Set'], deliveryIncentiveEligibleProductSlugs: ['noir-citrus-instant-drop'], deliveryIncentiveEligibleSizes: ['Full Bottle'], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p4', name: 'Amber Pulse — Direct Release', slug: 'amber-pulse-direct-release', prefix: 'baseItem2', tagline: 'FCFS / LIVE', desc: 'Cart-compatible direct release with three price points for mixed traffic.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 3,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'Three sizes, one checkout. Customers pick any mix into the cart and pay instantly — demos how a multi-SKU FCFS product behaves end to end.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Shows a 3-tier pricing ladder (card → travel spray → full bottle) and how an entry price point warms customers into the premium size.' },
      { label: 'PROS', name: 'Pros', text: 'Immediate revenue, repeat purchases, and a natural upsell path through bundle-friendly pricing.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Less selective than a draw, and lower-priced SKUs can cannibalize the hero size if priced too close.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Polished launches where the goal is speed and order value, not manufactured scarcity.' },
    ],
    priceCategories: [{ size: 'Fabric Card', price: 24, stripeId: defaultStripePriceId(), winnerTiers: '0' }, { size: 'Travel Spray', price: 62, stripeId: defaultStripePriceId(), winnerTiers: '0' }, { size: 'Full Bottle', price: 130, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 140, winnerTiers: [0], soldOutBehavior: 'archive_after_delay', soldOutArchiveDelayHours: 18, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p5', name: 'Velvet Resin — Upcoming', slug: 'velvet-resin-upcoming', prefix: 'elysian-white', tagline: 'UPCOMING / QUEUED', desc: 'Queued raffle with a real countdown, simulating the pre-launch anticipation window.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 4,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'Marked “upcoming” with a go-live timestamp. The storefront shows a live countdown and flips the product to open automatically when the clock hits zero.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Proves the scheduled-go-live mechanic — a client can queue a drop days ahead and the catalog will display it under Upcoming with real entry state.' },
      { label: 'PROS', name: 'Pros', text: 'Builds anticipation and pre-drop email signups without exposing checkout early.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Not monetizable until the go-live moment, so it depends on the countdown converting.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Teaser launches, influencer announcements, and anything that benefits from a fixed opening time.' },
    ],
    priceCategories: [{ size: 'Standard', price: 99, stripeId: defaultStripePriceId(), winnerTiers: '2,1,1' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 70, totalInventory: 70, winnerTiers: [2, 1, 1], goLiveAt: isoIn(36 * 60 * 60 * 1000), releaseEndsAt: isoIn(5 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 48, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p6', name: 'Solar Drift — Upcoming FCFS', slug: 'solar-drift-upcoming-fcfs', prefix: 'baseItem1', tagline: 'UPCOMING / FCFS', desc: 'Upcoming direct-buy release that opens in under an hour — a quick countdown demo.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 5,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'An FCFS product scheduled to open soon. When goLiveAt passes, it becomes a normal live buy — no admin action needed.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Pairs the countdown mechanic with direct checkout, so a client can market an exact opening second for a first-come drop.' },
      { label: 'PROS', name: 'Pros', text: 'Great for countdown marketing and influencer drops; converts the moment it opens.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Inventory can disappear very quickly once open, which is the intended tension for FCFS.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Time-boxed launches where precision timing is the hook.' },
    ],
    priceCategories: [{ size: 'Discovery Pair', price: 38, stripeId: defaultStripePriceId(), winnerTiers: '0' }, { size: 'Collector Bottle', price: 122, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 2, maxPerCart: 2, maxRaffleAllocationLimit: 0, totalInventory: 95, winnerTiers: [0], goLiveAt: isoIn(60 * 60 * 1000), releaseEndsAt: isoIn(4 * DAY_MS), soldOutBehavior: 'archive_after_delay', soldOutArchiveDelayHours: 12, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p7', name: 'Monolith Air — Upcoming', slug: 'monolith-air-upcoming', prefix: 'obsidian-void', tagline: 'UPCOMING / RAFFLE', desc: 'Low-allocation upcoming raffle with a visible countdown before activation.',
    isActive: true, isArchived: false, isUpcoming: true, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 6,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'A very tight upcoming raffle — only 45 units. It demos low-allocation raffle math and the two-day countdown before entries open.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Shows the extreme-scarcity end of the spectrum: tiny inventory, low winner tiers, and heavy anticipation — the full “not everyone gets through” story.' },
      { label: 'PROS', name: 'Pros', text: 'Maximum exclusivity and strong anticipation; great proof of demand when it sells.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Deliberately low conversion capacity, so it will never generate large revenue numbers.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Statement pieces and collector drops where scarcity IS the product.' },
    ],
    priceCategories: [{ size: 'Standard', price: 104, stripeId: defaultStripePriceId(), winnerTiers: '1,1,1' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 45, totalInventory: 45, winnerTiers: [1, 1, 1], goLiveAt: isoIn(2 * DAY_MS), releaseEndsAt: isoIn(6 * DAY_MS), soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 72, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p8', name: 'Atlas Bloom — Archive', slug: 'atlas-bloom-archive', prefix: 'baseItem2', tagline: 'ARCHIVE', desc: 'Completed direct drop that stays on the record as proof of demand.',
    isActive: true, isArchived: true, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 7,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'Archived products keep their full page, description, and history on the catalog’s Past Archives section — nothing is deleted.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Shows how sold-out or completed releases remain visible as social proof, so a catalog never looks empty and demand is always documented.' },
      { label: 'PROS', name: 'Pros', text: 'Excellent social proof and a permanent record of past sell-through.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Intentionally not the primary conversion surface anymore — it tells the story rather than closing the sale.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'A living archive that makes “everything sells out” look like the norm.' },
    ],
    priceCategories: [{ size: 'Standard', price: 118, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 0, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p9', name: 'Cinder Wave — Archive', slug: 'cinder-wave-archive', prefix: 'baseItem1', tagline: 'ARCHIVE', desc: 'Historic raffle archive entry that keeps old winner records presentable.',
    isActive: true, isArchived: true, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 8,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'An archived raffle with two winner tiers preserved in the ledger. Admins can still search it, re-export winners, and reference entry history.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Demonstrates that draw history is permanent — a client can show past allocation results while keeping the page clean and presentable.' },
      { label: 'PROS', name: 'Pros', text: 'Strong credibility and storytelling for future drops.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Meant for trust, not instant sales — don’t expect new orders from it.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Proving a track record before the next launch opens.' },
    ],
    priceCategories: [{ size: 'Standard', price: 102, stripeId: defaultStripePriceId(), winnerTiers: '2,2' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 0, winnerTiers: [2, 2], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p10', name: 'Mirage Salt — Hidden Draft', slug: 'mirage-salt-hidden-draft', prefix: 'baseItem2', tagline: 'DRAFT', desc: 'Hidden draft to simulate a non-published product staged for a future release.',
    isActive: false, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 9,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'isActive is false, so the product exists in the admin but is invisible on the storefront and catalog — a pure staging area.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Shows the draft workflow: build a product, upload imagery, set pricing, and only flip “Active” when the client is ready to publish.' },
      { label: 'PROS', name: 'Pros', text: 'Perfect for preparation and QA before a public release.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Invisible until activated, so it contributes nothing to traffic or revenue while drafted.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Pre-launch staging, client review, and seasonal planning.' },
    ],
    priceCategories: [{ size: 'Standard', price: 128, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 60, winnerTiers: [0], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p11', name: 'Night Petal — Live Draw', slug: 'night-petal-live-draw', prefix: 'elysian-white', tagline: 'RAFFLE / LIVE', desc: 'Secondary live raffle that runs in parallel with the hero draw.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: true, checkoutMode: 'RAFFLE', productType: 'raffle', sortOrder: 10,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'A second simultaneous raffle — separate pool, separate draw, own winner tiers. Proves multiple live draws can coexist in one storefront.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Demos multi-drop storefront behavior and lets an operator run a hero + companion launch at once, each with its own allocation.' },
      { label: 'PROS', name: 'Pros', text: 'More entry surface and revenue potential; each draw stays independently manageable.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Splits attention across two live offers, which can dilute focus on the hero.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Companion pieces, regional variants, or a second tier running beside the flagship.' },
    ],
    priceCategories: [{ size: 'Standard', price: 108, stripeId: defaultStripePriceId(), winnerTiers: '2,1,1' }], images: ['/images/elysian-white/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 80, totalInventory: 80, winnerTiers: [2, 1, 1], createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p12', name: 'Quartz Ember — Live FCFS', slug: 'quartz-ember-live-fcfs', prefix: 'obsidian-void', tagline: 'FCFS / LIVE', desc: 'Additional direct-buy listing to stress-test cart and checkout UX.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 11,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'An FCFS item with generous per-cart limits (3 each) so testers can stack sizes and verify the mixed cart + bundle checkout path.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'Demos how direct items stack into a cart for higher order value, including the mixed raffle + FCFS checkout flow.' },
      { label: 'PROS', name: 'Pros', text: 'Best for repeat buyers and bundles; exercises quantity limits and mixed-cart logic.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Less selective than a prestige draw and can feel like a commodity if over-stocked.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Cart stress testing, bundles, and higher-volume direct SKUs.' },
    ],
    priceCategories: [{ size: 'Standard', price: 152, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/obsidian-void/1.jpeg'],
    maxPerEmail: 3, maxPerCart: 3, maxRaffleAllocationLimit: 0, totalInventory: 180, winnerTiers: [0], soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 24, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p13', name: 'Halo Moss — Sold Out Proof', slug: 'halo-moss-sold-out-proof', prefix: 'baseItem1', tagline: 'FCFS / SOLD OUT', desc: 'A live-listed, fully sold-out drop kept visible as social proof.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 12,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'totalInventory is 0, so the storefront marks it sold out while “stay visible” keeps it on the active list — proof of demand, not a dead page.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'This is the “everything sells out” mechanic: a sold-out product stays front and center so new visitors see momentum before the next drop.' },
      { label: 'PROS', name: 'Pros', text: 'Instant social proof and urgency; the page still tells the full release story.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'Takes a slot on the active list without generating new orders.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Keeping a catalog looking successful between drops.' },
    ],
    priceCategories: [{ size: 'Standard', price: 88, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/baseItem1/1.jpeg'],
    maxPerEmail: 1, maxPerCart: 1, maxRaffleAllocationLimit: 0, totalInventory: 0, winnerTiers: [0], soldOutBehavior: 'stay_visible', soldOutArchiveDelayHours: 24, createdAt: NOW, updatedAt: NOW,
  },
  {
    id: 'p14', name: 'Gilded Hour — Member Bundle', slug: 'gilded-hour-member-bundle', prefix: 'baseItem2', tagline: 'FCFS / LIVE', desc: 'Multi-size direct drop with per-order incentives and generous cart limits.',
    isActive: true, isArchived: false, isUpcoming: false, isRaffle: false, checkoutMode: 'FCFS', productType: 'checkout', sortOrder: 13,
    notes: [
      { label: 'MODE', name: 'How it works', text: 'Three sizes plus a delivery incentive: buying the Discovery Kit triggers store credit toward the full bottle, and up to 4 units per cart.' },
      { label: 'WHY', name: 'Why this drop matters', text: 'The most complete FCFS demo: multi-SKU pricing, quantity caps, and an incentive that upsells a small first order into the hero size.' },
      { label: 'PROS', name: 'Pros', text: 'High average order value, natural repeat-buy behavior, and a built-in demo of delivery incentives.' },
      { label: 'CONS', name: 'Cons / tradeoffs', text: 'More moving parts than a simple drop — needs clean product config to avoid confusion.' },
      { label: 'PURPOSE', name: 'Best used for', text: 'Bundles, memberships, and any drop where the goal is maximizing order value.' },
    ],
    priceCategories: [{ size: 'Discovery Kit', price: 42, stripeId: defaultStripePriceId(), winnerTiers: '0' }, { size: 'Full Bottle', price: 168, stripeId: defaultStripePriceId(), winnerTiers: '0' }, { size: 'Grand Size', price: 240, stripeId: defaultStripePriceId(), winnerTiers: '0' }], images: ['/images/baseItem2/1.jpeg'],
    maxPerEmail: 4, maxPerCart: 4, maxRaffleAllocationLimit: 0, totalInventory: 220, winnerTiers: [0], soldOutBehavior: 'archive_after_delay', soldOutArchiveDelayHours: 30, deliveryIncentiveEnabled: true, deliveryIncentiveCreditCents: 2000, deliveryIncentiveMinOrderSubtotalCents: 12000, deliveryIncentiveExpiresDays: 45, deliveryIncentiveCodePrefix: 'GILDE', deliveryIncentiveTriggerSizes: ['Discovery Kit'], deliveryIncentiveEligibleProductSlugs: ['gilded-hour-member-bundle'], deliveryIncentiveEligibleSizes: ['Full Bottle', 'Grand Size'], createdAt: NOW, updatedAt: NOW,
  },
];

const DEFAULT_CONFIG = {
  themeColors: {
    primaryBackground: '#f2f2f7',
    cardBackground: '#ffffff',
    cardBorder: 'rgba(0,0,0,0.14)',
    accentPurple: '#bf5af2',
    accentBlue: '#0071e3',
    textMain: '#1d1d1f',
    textMuted: '#52525a',
    cardTextMain: '#1d1d1f',
    cardTextMuted: '#52525a',
    checkoutCtaButton: '#0071e3',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    borderRadius: 24,
    // Transparency (0-100): chrome = header/footer/drawer, surface = cards.
    chromeTransparency: 62,
    surfaceTransparency: 98,
    // Apple design-language defaults: squircle corners, soft layered card
    // shadows, and a heavy Liquid-Glass backdrop for the chrome surfaces.
    radiusStyle: 'squircle',
    cardShadow: 14,
    backdropBlur: 80,
    contentSpacing: 'comfortable',
  },
  // Default Branding & Share — refined noir & gold so a freshly seeded store's
  // favicon, share card and header look intentional out of the box.
  branding: {
    logoUrl: '',
    logoWidth: 28,
    logoHeight: 28,
    logoTransparent: false,
    brandName: '',
    brandFontFamily: '',
    headerMode: 'both',
    headerActionMode: 'cart',
    shareImageUrl: '',
    shareTitle: '',
    shareDescription: 'Handcrafted fragrance allocations — private raffle drops, first-access alerts, and clean checkout for high-intent collectors.',
    shareBackground: '#0B0B0F',
    shareAccent: '#D4AF37',
    shareText: '#F5F2E9',
    iconBackground: '#0B0B0F',
    iconText: '#D4AF37',
  },
  // Rewards & points: earn on purchases, redeem for store credit.
  rewards: {
    pointsPerDollar: 100,
    minRedeemPoints: 100,
    maxRedeemPoints: 0,
    purchasePointsPerDollar: 10,
    giftingEnabled: true,
    giftDiscountPercent: 10,
    // Custom caption under the redeem box in /account. Empty = built-in copy.
    redemptionInfoMessage: '',
  },
  // Product gallery: auto-advancing photos with a slow cinematic zoom.
  gallery: {
    autoPlay: true,
    intervalSeconds: 4,
    zoom: true,
    zoomDurationSeconds: 14,
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
    autoIncrementChancePerHeartbeat: 0.15,
    autoIncrementAmount: 1,
    autoIncrementMaxPerDay: 4,
    autoIncrementMinHourGap: 3,
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
  legal: DEFAULT_LEGAL,
};

export async function runSeedDefaults(redis: any): Promise<{ seeded: number; liveSeeded: number; verifyCount: number }> {
  const existing = await redis.hgetall(PRODUCTS_KEY);
  if (existing && Object.keys(existing).length > 0) {
    return { seeded: 0, liveSeeded: 0, verifyCount: Object.keys(existing).length };
  }

  let seeded = 0;
  for (const product of DEFAULT_PRODUCTS) {
    await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
    seeded++;
  }

  await redis.set(STORE_CONFIG_KEY, JSON.stringify(DEFAULT_CONFIG));

  // Seed live states for every product/size so a fresh store is immediately
  // ready (the storefront + self-test expect active products to have live
  // states). getLiveProductState is idempotent and mirrors product stock.
  let liveSeeded = 0;
  for (const product of DEFAULT_PRODUCTS) {
    const raffleLimit = Math.max(0, Number(product.maxRaffleAllocationLimit) || 0);
    const stock = Math.max(0, Number(product.totalInventory) || 0);
    if (raffleLimit <= 0 && stock <= 0) continue; // intentional sold-out placeholder
    const categories = Array.isArray(product.priceCategories) && product.priceCategories.length > 0
      ? product.priceCategories
      : [{ size: 'Standard' }];
    for (const cat of categories) {
      try {
        // Seed the live state with the product's first-tier winner count (e.g.
        // winnerTiers [3,2,2] → 3 winners on draw 1). Passing it here means the
        // admin's Trigger Drop and the auto-draw engine agree with the product's
        // advertised tiers instead of a default of 1.
        const firstTier = Array.isArray(product.winnerTiers) && product.winnerTiers.length > 0
          ? Math.max(1, Number(product.winnerTiers[0]) || 1)
          : 1;
        await getLiveProductState(redis, product, String(cat.size || 'Standard'), firstTier);
        liveSeeded++;
      } catch (err: any) {
        console.warn(`[seed] Could not seed live state for ${product.name} (${cat.size}):`, err);
      }
    }
  }

  const verify = await redis.hgetall(PRODUCTS_KEY);
  const verifyCount = verify ? Object.keys(verify).length : 0;

  try {
    await appendAudit(redis, { action: 'DEFAULTS_SEEDED', detail: `Seeded ${seeded} products · live states ${liveSeeded}`, actor: 'admin' });
  } catch {}

  return { seeded, liveSeeded, verifyCount };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const password = url.searchParams.get('password') || '';

    if (!adminRequestAuthorized(request, password)) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const redis = createRedisClient();
    if (!redis) {
      return NextResponse.json({ error: 'Redis offline' }, { status: 500 });
    }

    const { seeded, liveSeeded, verifyCount } = await runSeedDefaults(redis);

    if (seeded === 0 && verifyCount > 0) {
      return NextResponse.json({
        success: true,
        message: `Products already exist in Redis (${verifyCount} products). No seeding needed.`,
        count: verifyCount,
      });
    }

    return NextResponse.json({
      success: true,
      message: `Seeded ${seeded} products to Redis. Verified: ${verifyCount} products exist. Live states: ${liveSeeded}.`,
      products: DEFAULT_PRODUCTS.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
      liveStatesSeeded: liveSeeded,
      verified: verifyCount,
    });
  } catch (err: any) {
    console.error('[seed] Error:', err);
    return NextResponse.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}