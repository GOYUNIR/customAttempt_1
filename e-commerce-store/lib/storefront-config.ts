import { DEFAULT_LEGAL, type StoreLegalConfig } from '@/lib/legal-config';
import { dropTimestampToMs } from './drop-timestamps';
// Category + catalog-entry helpers live in the self-contained ./catalog-entries
// module (no `@/` imports) so `node --test` can load them directly. Import +
// re-export keeps every existing `from '@/lib/storefront-config'` import intact.
import { normalizeCategories, visibleProductCategories, filterStaleCatalogEntries } from './catalog-entries';
export { normalizeCategories, visibleProductCategories, filterStaleCatalogEntries };

export interface StorefrontNote {
  label: string;
  name: string;
  text: string;
}

export interface DropScheduleConfig {
  mode: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
  timezone: string;
  targetEndDateTime: string; // used when mode is 'fixed', and as the anchor date/time for 'biweekly' and 'yearly'
  drawDayOfWeek: number;     // 0=Sun...6=Sat, used when mode is 'weekly'
  drawDayOfMonth: number;    // 1-31, used when mode is 'monthly' (clamped to the last real day of shorter months)
  drawHour: number;          // used by 'hourly' / 'daily' / 'weekly' / 'monthly'
  drawMinute: number;
  /** 0-59, used by hourly/daily/weekly/monthly (optional, default 0) */
  drawSecond?: number;
  /** Used when mode is 'custom' — how many hours each raffle round lasts
   *  (e.g. 6 → a new draw every 6 hours). Any positive whole number. */
  customIntervalHours?: number;
  countdownExpiredText: string;
  daysLabel: string;
  hoursLabel: string;
  minutesLabel: string;
  secondsLabel: string;
  // Fallback winner counts, used only the FIRST time a product/size is seen
  // (to seed its live state in Redis). After that, edit winner tiers from
  // the admin portal — changing these numbers here will NOT affect a
  // product that's already live.
  winnersPer50ml: number;
  winnersPer100ml: number;
}

export interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  price50ml?: number;
  price100ml?: number;
  stripeId50ml?: string;
  stripeId100ml?: string;
  priceCategories?: Array<{ size: string; price: number; stripeId?: string; winnerTiers?: string | number[] }>;
  maxRaffleAllocationLimit: number;
  isActive?: boolean;
  isArchived?: boolean;
  isUpcoming?: boolean;
  isRaffle?: boolean;
  productType?: string;
  accent?: string;
  notes: StorefrontNote[];
  images?: string[];
  /** Parallel to `images`: per-media crop records (normalized center + size). */
  crops?: Array<{ x: number; y: number; w: number; h: number }>;
  customDropSchedule?: Partial<DropScheduleConfig>;
  scheduledArchiveAt?: string;
  scheduledUnarchiveAt?: string;
  catalogImage?: string;
  totalInventory?: number;
  winnerTiers?: number[];
}

export interface CatalogPreviewItem {
  name: string;
  status: string;
  eta?: string;
  image?: string;
  description?: string;
  availableFrom?: string;
  availableUntil?: string;
  slug?: string;
}

/** One glow orb (top-bar orb uses px size; background orbs use vw size). */
export interface OrbVisualConfig {
  enabled: boolean;
  color: string;   // hex, e.g. '#3b82f6'
  opacity: number; // 0-100
  size: number;    // top-bar orb: px; background orbs: vw units
}

/** Physics + behaviour controls for the orb system. */
export interface OrbMotionConfig {
  idleEnabled: boolean;    // drift around the page while idle
  pointerEnabled: boolean; // follow the cursor
  scrollEnabled: boolean;  // react to page scroll
  intensity: number;       // 20-200 — how far orbs travel (% of default range)
  speed: number;           // 30-200 — spring stiffness (higher = snappier)
  momentum: number;        // 0-100 — heaviness / glide (higher = heavier, more drift)
}

export interface OrbsConfig {
  enabled: boolean;
  primary: OrbVisualConfig;
  secondary: OrbVisualConfig;
  tertiary: OrbVisualConfig;
  fourth: OrbVisualConfig;
  fifth: OrbVisualConfig;
  motion: OrbMotionConfig;
}

export interface StorefrontConfig {
  themeColors: {
    primaryBackground: string;
    cardBackground: string;
    cardBorder: string;
    accentPurple: string;
    accentBlue: string;
    textMain: string;
    textMuted: string;
    /** Primary text color rendered on card/info-box backgrounds. */
    cardTextMain: string;
    /** Secondary/muted text color rendered on card/info-box backgrounds. */
    cardTextMuted: string;
    checkoutCtaButton: string;
    /** Top-bar (header) background — optional. Empty = derive from cardBackground
     *  at the chrome transparency (the classic look). Set from /admin → Settings
     *  → Theme Colors so the top bar can be branded independently of the cards. */
    headerBackground?: string;
    /** Top-bar text/icon color — optional. Empty = auto pick a readable color
     *  from the header background. */
    headerText?: string;
    /** CSS font stack applied to the storefront body (set by design presets). */
    fontFamily?: string;
    /** Border radius in px — 0 = square, ~10 = small rounded, 999 = fully rounded. */
    borderRadius?: number;
    /** Header/footer/cart-drawer opacity (0-100) — set from /admin → Settings. */
    chromeTransparency?: number;
    /** Card/surface opacity (0-100) — set from /admin → Settings. */
    surfaceTransparency?: number;
    /** Corner style: 'squircle' (Apple continuous curve — default), 'rounded',
     *  or 'sharp'. Scales the configured borderRadius token. */
    radiusStyle?: 'squircle' | 'rounded' | 'sharp';
    /** Soft card shadow intensity (0-100) — 0 = flat, ~12 = Apple default. */
    cardShadow?: number;
    /** Frosted-glass backdrop blur (0-100) for the header / cart drawer / modals. */
    backdropBlur?: number;
    /** Page rhythm: 'compact' | 'comfortable' (default) | 'spacious'. */
    contentSpacing?: 'compact' | 'comfortable' | 'spacious';
  };
  availableSizes: string[];
  homeRedirectSlug?: string;
  dropSchedule: DropScheduleConfig;
  animationMechanics: {
    totalFramesToLoad: number;
    maxRotationDegrees: number;
    spinReverseOnAlternatingProgress: boolean;
    spinCyclesTopToCheckout: number;
  };
  raffleRegistrationForm: {
    titleHeader: string;
    emailLabel: string;
    emailPlaceholder: string;
    addressLabel: string;
    addressPlaceholder: string;
    submitButtonText: string;
    submitButtonLoadingText: string;
  };
  heroContent: {
    eyebrow: string;
    headline: string;
    body: string;
    ctaLabel: string;
    storyHeadline: string;
    storyBody: string;
    /** Per-element show/hide toggles for the home-page hero (default ALL on). */
    showEyebrow?: boolean;
    showHeadline?: boolean;
    showBody?: boolean;
    showCta?: boolean;
    showStory?: boolean;
  };
  socialProof: {
    label: string;
    baseCount: number;
    caption: string;
    autoIncrementEnabled: boolean;
    autoIncrementChancePerHeartbeat: number;
    autoIncrementAmount: number;
    // "x times a day, x hour gap" controls for the social-proof auto-tick
    // engine (used by /api/analytics/heartbeat + /api/analytics/social-tick):
    autoIncrementMaxPerDay: number;   // hard cap on how many times/day it can tick up
    autoIncrementMinPerDay: number;   // guaranteed minimum ticks/day (spread across the day)
    autoIncrementMinHourGap: number;  // minimum hours between ticks
    autoIncrementMaxHourGap: number;  // force a tick when stale beyond this threshold
    /** Show the whole social-proof counter on the home page (default true). */
    showSection?: boolean;
    /** Show the caption line under the count (default true). */
    showCaption?: boolean;
  };
  brandFooterData: {
    instagramLink: string;
    tiktokLink: string;
    supportEmail: string;
    shippingReturnPolicyText: string;
    corporateEntityCopyright: string;
    /** Show the footer tagline line (default true). */
    showTagline?: boolean;
  };
  catalogPreview: {
    upcomingDrops: CatalogPreviewItem[];
    archiveScents: CatalogPreviewItem[];
  };
  /** Catalog presentation settings (admin → Settings → Catalog). */
  catalog?: {
    /** Order of the /catalog sections: 'live' | 'upcoming' | 'archive'. */
    sectionOrder?: string[];
    /** Admin-managed product categories; products are tagged with any subset. */
    categories?: string[];
  };
  /** Checkout & orders policy (admin → Settings → Checkout & Orders). */
  checkout?: {
    /** When ON (default), customer "update address" flows require the full
     *  Mapbox-dropdown address — a partial address can never be saved. */
    requireAddressAutofill?: boolean;
  };
  orbs: OrbsConfig;
  /** Legal & policy content for /terms, /privacy, /shipping (admin-editable). */
  legal: StoreLegalConfig;
  productCatalog: StorefrontProduct[];
}

const defaultThemeColors = {
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
  // Top bar colors: empty = auto (derived from cardBackground + chrome
  // transparency, readable text picked automatically).
  headerBackground: '',
  headerText: '',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  borderRadius: 24,
  // Transparency (0-100, editable from /admin → Settings → Theme Colors):
  // chromeTransparency controls header/footer/cart-drawer opacity,
  // surfaceTransparency controls card/surface opacity on the storefront.
  chromeTransparency: 62,
  surfaceTransparency: 98,
  // Apple design-language defaults: squircle corners, soft layered card
  // shadows, and a heavy Liquid-Glass backdrop for the chrome surfaces.
  radiusStyle: 'squircle' as const,
  cardShadow: 14,
  backdropBlur: 80,
  contentSpacing: 'comfortable' as const,
};

const defaultDropSchedule: DropScheduleConfig = {
  mode: 'weekly',
  timezone: 'America/Los_Angeles',
  targetEndDateTime: '2026-07-27T19:30:00',
  drawDayOfWeek: 6,
  drawDayOfMonth: 1,
  drawHour: 21,
  drawMinute: 0,
  drawSecond: 0,
  customIntervalHours: 24,
  countdownExpiredText: 'ALLOCATION. CLOSED • VARIANT ARCHIVED',
  daysLabel: 'd',
  hoursLabel: 'h',
  minutesLabel: 'm',
  secondsLabel: 's',
  winnersPer50ml: 10,
  winnersPer100ml: 5,
};

const defaultAnimationMechanics = {
  totalFramesToLoad: 4,
  maxRotationDegrees: 360,
  spinReverseOnAlternatingProgress: true,
  spinCyclesTopToCheckout: 4,
};

const defaultFormCopy = {
  titleHeader: 'Join The Allocation Draw',
  emailLabel: 'Contact Email Address',
  emailPlaceholder: 'name@domain.com',
  addressLabel: 'Full Shipping Destination',
  addressPlaceholder: '123 Luxury Dr, New York, NY',
  submitButtonText: '🏆 Secure Entry Allocation Ticket',
  submitButtonLoadingText: 'Encrypting Entry Base...',
};

const defaultHeroContent = {
  eyebrow: 'CALIFORNIA USA',
  headline: 'by our hands. to your hands.',
  body: 'homemade & designed, with real ingredients, with real hands. for real people.',
  ctaLabel: 'Browse drops',
  storyHeadline: 'Our Story',
  storyBody: 'take control.',
  // Every hero element shows by default; admin can hide any of them.
  showEyebrow: true,
  showHeadline: true,
  showBody: true,
  showCta: true,
  showStory: true,
};

const defaultSocialProof = {
  label: 'Limited drop access',
  baseCount: 0,
  caption: 'Hype is compounding fast—reserve now before inventory closes.',
  autoIncrementEnabled: true,
  autoIncrementChancePerHeartbeat: 0.18,
  autoIncrementAmount: 2,
  autoIncrementMaxPerDay: 4,
  autoIncrementMinPerDay: 3,
  autoIncrementMinHourGap: 2,
  autoIncrementMaxHourGap: 8,
  showSection: true,
  showCaption: true,
};

const defaultFooter = {
  instagramLink: '',
  tiktokLink: '',
  supportEmail: '',
  shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
  corporateEntityCopyright: 'ALL RIGHTS RESERVED.',
  showTagline: true,
};

/** Default catalog presentation settings (admin → Settings → Catalog). */
const defaultCatalogSettings: NonNullable<StorefrontConfig['catalog']> = {
  // Default /catalog section order: live at the BOTTOM (per the template
  // default) — operators can reorder from /admin → Settings → Catalog.
  sectionOrder: ['upcoming', 'archive', 'live'],
  // Admin-managed categories (Settings → Catalog → Categories). EMPTY until
  // the seed runs — an unseeded store deliberately has no categories.
  categories: [],
};

/** Default checkout & orders policy (admin → Settings → Checkout & Orders). */
const defaultCheckoutSettings: NonNullable<StorefrontConfig['checkout']> = {
  requireAddressAutofill: true,
};

/**
 * Whether customer "update address" flows must reject partial addresses
 * (require the full Mapbox-dropdown address). Defaults to TRUE when the
 * config flag is absent. The admin portal can turn this off and save a
 * partial address regardless.
 */
export function requireAddressAutofill(config: Record<string, any> | null | undefined): boolean {
  return config?.checkout?.requireAddressAutofill !== false;
}

// Default orb system — background glow orbs plus the animated top-bar orb.
// Every value here is editable live from /admin → Settings → Orb Glow.
const defaultOrbs: OrbsConfig = {
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
};

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
function normalizeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function normalizeCatalogItems(items: unknown): CatalogPreviewItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter(Boolean).map((item: any) => ({
    name: normalizeText(item?.name, 'Untitled Item'),
    status: normalizeText(item?.status, 'Coming Soon'),
    eta: typeof item?.eta === 'string' ? item.eta : undefined,
    image: typeof item?.image === 'string' ? item.image : undefined,
    description: typeof item?.description === 'string' ? item.description : undefined,
    availableFrom: typeof item?.availableFrom === 'string' ? item.availableFrom : undefined,
    availableUntil: typeof item?.availableUntil === 'string' ? item.availableUntil : undefined,
    slug: typeof item?.slug === 'string' ? item.slug : undefined,
  }));
}

function normalizeProduct(product: Partial<StorefrontProduct> & { id?: string }, index: number): StorefrontProduct {
  const fallbackName = `Drop ${index + 1}`;
  const fallbackSlug = `${product.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const fallbackSize = 'Standard';
  const normalizedPriceCategories = Array.isArray(product.priceCategories) && product.priceCategories.length > 0
    ? product.priceCategories.map((category: any) => ({
        size: normalizeText(category?.size, fallbackSize),
        price: normalizeNumber(category?.price, 0),
        stripeId: normalizeText(category?.stripeId, ''),
        winnerTiers: typeof category?.winnerTiers === 'string' ? category.winnerTiers : (Array.isArray(category?.winnerTiers) ? category.winnerTiers.join(',') : '0'),
      }))
    : [{ size: fallbackSize, price: UNCONFIGURED_PRICE_SENTINEL, stripeId: '', winnerTiers: '0' }];

  return {
    id: normalizeText(product.id, `p${index + 1}`),
    name: normalizeText(product.name, fallbackName),
    slug: normalizeText(product.slug, fallbackSlug),
    prefix: normalizeText(product.prefix, fallbackSlug),
    tagline: normalizeText(product.tagline, 'LIMITED DROP'),
    desc: normalizeText(product.desc, 'A refined signature profile for the next allocation window.'),
    price50ml: normalizeNumber(product.price50ml, 0),
    price100ml: normalizeNumber(product.price100ml, 0),
    stripeId50ml: normalizeText(product.stripeId50ml, ''),
    stripeId100ml: normalizeText(product.stripeId100ml, ''),
    priceCategories: normalizedPriceCategories,
    maxRaffleAllocationLimit: normalizeNumber(product.maxRaffleAllocationLimit, 0),
    isActive: product.isActive ?? true,
    isArchived: Boolean(product.isArchived),
    isUpcoming: Boolean(product.isUpcoming),
    isRaffle: product.isRaffle !== false,
    productType: normalizeText(product.productType, 'raffle'),
    accent: normalizeText(product.accent, ''),
    notes: (product.notes ?? []).map((note) => ({
      label: normalizeText(note?.label, 'PROFILE'),
      name: normalizeText(note?.name, 'Signature Note'),
      text: normalizeText(note?.text, 'A polished profile note designed for instant recognition.'),
    })),
    images: Array.isArray(product.images) ? product.images : [],
    crops: Array.isArray(product.crops) ? product.crops : undefined,
    customDropSchedule: product.customDropSchedule,
    scheduledArchiveAt: product.scheduledArchiveAt,
    scheduledUnarchiveAt: product.scheduledUnarchiveAt,
    catalogImage: product.catalogImage,
    totalInventory: product.totalInventory,
    winnerTiers: product.winnerTiers,
  };
}

/**
 * Apply a surface transparency (0-100) to a card background color.
 * Uses `color-mix` so any CSS color works; falls back to the solid color when
 * the transparency is missing/100. Used by storefront surfaces driven by the
 * /admin → Settings → Theme Colors → "Surface opacity" slider.
 */
export function surfaceBackground(color?: string, transparencyPct?: number | string, fallback = ''): string {
  const c = String(color || '').trim();
  const pct = Number(transparencyPct);
  if (!Number.isFinite(pct) || pct >= 100) return c || fallback;
  const safe = Math.max(0, Math.min(100, pct));
  return `color-mix(in srgb, ${c || fallback} ${safe}%, transparent)`;
}

/**
 * Resolve the admin "Border Radius (px)" token (`themeColors.borderRadius`) as a
 * NUMBER. This is the SINGLE source of truth for card/surface roundness across
 * EVERY storefront surface (home, catalog, product, account, auth, story,
 * legal, waitlist, 404). The configured `radiusStyle` further refines it:
 *
 *   - `squircle` (default) — the configured px value, Apple's precise
 *     continuous-corner feel.
 *   - `rounded` — ~72% of the configured value (smaller, softer corners).
 *   - `sharp` — clamped to 4px (flat, editorial).
 *
 * `fallback` applies only when the token is missing / non-numeric / negative.
 * Buttons and pills keep their fully-rounded 999px shape by design — that pill
 * language is intentional and NOT tokenized.
 */
export function themeRadiusNumber(themeColors?: Record<string, any> | null, fallback = 22): number {
  const r = Number(themeColors?.borderRadius);
  const base = Number.isFinite(r) && r >= 0 ? r : fallback;
  const style = String(themeColors?.radiusStyle || 'squircle');
  if (style === 'sharp') return Math.min(4, Math.round(base));
  if (style === 'rounded') return Math.max(2, Math.round(base * 0.72));
  return Math.round(base);
}

/** CSS `px` string version of `themeRadiusNumber` (e.g. `"22px"`). */
export function themeRadius(themeColors?: Record<string, any> | null, fallback = 22): string {
  return `${themeRadiusNumber(themeColors, fallback)}px`;
}

/**
 * Apple-style soft, low-intensity card shadow built from the admin
 * `themeColors.cardShadow` slider (0-100, default ~12). 0 returns `none` (flat
 * surfaces), 100 returns a pronounced layered shadow. Deliberately subtle at the
 * default so cards read as tactile materials, not glowing boxes.
 */
export function cardShadowStyle(themeColors?: Record<string, any> | null, fallback = 12): string {
  const raw = Number(themeColors?.cardShadow);
  const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : fallback;
  if (pct <= 0) return 'none';
  const y = 1 + pct * 0.18;
  const blur = 12 + pct * 0.48;
  const a1 = 0.05 + pct * 0.0035;
  const a2 = 0.02 + pct * 0.002;
  return `0 1px 2px rgba(0,0,0,${a2.toFixed(3)}), 0 ${y.toFixed(1)}px ${blur.toFixed(1)}px rgba(0,0,0,${a1.toFixed(3)})`;
}

/**
 * Frosted-glass `backdrop-filter` value built from the admin
 * `themeColors.backdropBlur` slider (0-100, default ~55). 0 returns `none`
 * (fully opaque chrome), 100 returns a heavy 40px blur + strong saturation +
 * a gentle brightness lift — Apple's Liquid Glass material feel for the
 * header, cart drawer and modals. The `brightness()` term makes the backdrop
 * slightly "vibrant" (the way iOS glass glows), not just blurred.
 */
export function glassBackdrop(themeColors?: Record<string, any> | null, fallback = 55): string {
  const raw = Number(themeColors?.backdropBlur);
  const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : fallback;
  if (pct <= 0) return 'none';
  const px = Math.round(6 + (pct / 100) * 34);
  const sat = Math.round(140 + (pct / 100) * 70);
  const bright = Math.round(100 + (pct / 100) * 12);
  return `blur(${px}px) saturate(${sat}%) brightness(${bright}%)`;
}

export type GlassSurfaceOptions = {
  /** Explicit chrome background — overrides the automatic chrome-tinted mix. */
  bg?: string;
  /** Dark panel mode (cart drawer, toasts) — brighter specular sheen, lighter hairline. */
  dark?: boolean;
  /** Fallback backdropBlur (0-100) when the admin token is missing. */
  blur?: number;
  /** Override the outer soft shadow (defaults to a light card float). */
  shadow?: string;
};

/**
 * Apple Liquid Glass — the FULL chrome material in one style object. Use on
 * the header, cart drawer, modals and toasts so every glass surface shares
 * the same recipe.
 *
 * IMPORTANT DESIGN DECISION: the material is FLAT by default. There is no
 * painted specular sheen — the surface is a plain translucent color, and the
 * frosted-glass `backdrop-filter` is the only "glass" that shows, and it only
 * shows when real content scrolls beneath. This is deliberate: a painted
 * white sheen gradient on top of a dark header looks like a smudge when there
 * is nothing behind it. A flat translucent surface with a hairline border and
 * a barely-there top light reads as clean glass in every state.
 *
 * Returns a plain style record (no React dependency) so both server and
 * client components can spread it: `style={{ ...glassSurfaceStyle(theme) }}`.
 */
export function glassSurfaceStyle(themeColors?: Record<string, any> | null, opts: GlassSurfaceOptions = {}): Record<string, string> {
  const blur = glassBackdrop(themeColors, opts.blur ?? 55);
  const chrome = Number(themeColors?.chromeTransparency);
  const chromeAlpha = Number.isFinite(chrome) ? Math.max(30, Math.min(100, chrome)) : 62;
  const base = String(themeColors?.primaryBackground || '#f2f2f7');
  const bg = opts.bg || (chromeAlpha >= 100 ? base : `color-mix(in srgb, ${base} ${chromeAlpha}%, transparent)`);
  // Barely-there top light: a hairline "glass catches light" highlight, NOT a
  // band. Flat on light glass (white-on-white is invisible), a subtle rim on
  // dark panels so the drawer still reads as a material edge.
  const sheen = opts.dark
    ? 'linear-gradient(180deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.02) 22%, rgba(255,255,255,0) 44%)'
    : 'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.012) 22%, rgba(255,255,255,0) 44%)';
  const borderColor = opts.dark ? 'rgba(255,255,255,0.16)' : String(themeColors?.cardBorder || 'rgba(0,0,0,0.10)');
  const outer = opts.shadow ?? (opts.dark ? '0 10px 40px rgba(0,0,0,0.35)' : '0 8px 32px rgba(0,0,0,0.10)');
  return {
    background: bg,
    backgroundImage: sheen,
    WebkitBackdropFilter: blur,
    backdropFilter: blur,
    border: `1px solid ${borderColor}`,
    boxShadow: `inset 0 1px 0 ${opts.dark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.10)'}, inset 0 -1px 0 rgba(255,255,255,0.05), ${outer}`,
  };
}

/** Static specular sheen for CARD surfaces — the top "glass catches light"
 * highlight. Deliberately cheap: a painted-once gradient with NO backdrop-filter
 * (perf rule: never blur()/backdrop-filter animated or large elements). Pairs
 * with the chrome Liquid Glass (`glassSurfaceStyle`) so cards feel like the
 * same material without the per-frame cost. Spread into a style object's
 * `backgroundImage` alongside the existing `background` color. */
export const cardSheen =
  'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 26%, rgba(255,255,255,0) 52%)';

/** Multiplier for page rhythm from `themeColors.contentSpacing`. */
export function contentSpacingScale(themeColors?: Record<string, any> | null): number {
  const mode = String(themeColors?.contentSpacing || 'comfortable');
  if (mode === 'compact') return 0.88;
  if (mode === 'spacious') return 1.15;
  return 1;
}

/**
 * A heroContent blob is "legacy" when it was written by the OLD admin settings
 * (before the story fields existed) — i.e. it lacks both `storyHeadline` and
 * `storyBody`. Such blobs were never actually displayed (the home page used to
 * hardcode its hero copy), so we treat them as stale and fall back to the
 * current defaults instead of surfacing forgotten text after an upgrade.
 */
export function isLegacyHeroContent(hero: any): boolean {
  return !!hero && typeof hero !== 'string' && typeof hero.storyHeadline !== 'string' && typeof hero.storyBody !== 'string';
}

/** Deep-merge a stored (partial) orbs config over the defaults. */
export function mergeOrbsConfig(input?: Partial<OrbsConfig> | null): OrbsConfig {
  if (!input) return defaultOrbs;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaultOrbs.enabled,
    primary: { ...defaultOrbs.primary, ...(input.primary || {}) },
    secondary: { ...defaultOrbs.secondary, ...(input.secondary || {}) },
    tertiary: { ...defaultOrbs.tertiary, ...(input.tertiary || {}) },
    fourth: { ...defaultOrbs.fourth, ...(input.fourth || {}) },
    fifth: { ...defaultOrbs.fifth, ...(input.fifth || {}) },
    motion: { ...defaultOrbs.motion, ...(input.motion || {}) },
  };
}

export function buildStorefrontConfig(input: Partial<StorefrontConfig> = {}): StorefrontConfig {
  const productCatalog = Array.isArray(input.productCatalog)
    ? input.productCatalog.filter(Boolean).map((product, index) => normalizeProduct(product as any, index))
    : [];

  const sizes = Array.isArray(input.availableSizes) && input.availableSizes.length > 0
    ? input.availableSizes.map(String)
    : ['Standard'];

  return {
    themeColors: { ...defaultThemeColors, ...(input.themeColors ?? {}) },
    availableSizes: sizes,
    homeRedirectSlug: input.homeRedirectSlug,
    dropSchedule: { ...defaultDropSchedule, ...(input.dropSchedule ?? {}) },
    animationMechanics: { ...defaultAnimationMechanics, ...(input.animationMechanics ?? {}) },
    raffleRegistrationForm: { ...defaultFormCopy, ...(input.raffleRegistrationForm ?? {}) },
    heroContent: { ...defaultHeroContent, ...(input.heroContent ?? {}) },
    socialProof: { ...defaultSocialProof, ...(input.socialProof ?? {}) },
    brandFooterData: { ...defaultFooter, ...(input.brandFooterData ?? {}) },
    catalogPreview: {
      upcomingDrops: normalizeCatalogItems(input.catalogPreview?.upcomingDrops),
      archiveScents: normalizeCatalogItems(input.catalogPreview?.archiveScents),
    },
    catalog: {
      sectionOrder: Array.isArray(input.catalog?.sectionOrder) && input.catalog.sectionOrder.length > 0
        ? input.catalog.sectionOrder.map(String)
        : defaultCatalogSettings.sectionOrder,
      categories: normalizeCategories(input.catalog?.categories ?? defaultCatalogSettings.categories),
    },
    checkout: {
      requireAddressAutofill: input.checkout?.requireAddressAutofill ?? defaultCheckoutSettings.requireAddressAutofill,
    },
    orbs: mergeOrbsConfig(input.orbs),
    legal: { ...DEFAULT_LEGAL, ...(input.legal ?? {}) },
    productCatalog,
  };
}

export function getVisibleProducts(config: StorefrontConfig): StorefrontProduct[] {
  return config.productCatalog.filter((product) => product.isActive !== false);
}

export function getDrawIntervalMs(schedule: Partial<DropScheduleConfig> | undefined): number | null {
  switch (schedule?.mode) {
    case 'hourly': return 60 * 60 * 1000;
    case 'daily': return 24 * 60 * 60 * 1000;
    case 'weekly': return 7 * 24 * 60 * 60 * 1000;
    case 'biweekly': return 14 * 24 * 60 * 60 * 1000;
    case 'monthly': return 30 * 24 * 60 * 60 * 1000;
    case 'yearly': return 365 * 24 * 60 * 60 * 1000;
    case 'custom': {
      const hours = Math.max(1, Number(schedule?.customIntervalHours) || 0);
      return hours > 0 ? hours * 60 * 60 * 1000 : null;
    }
    default: return null;
  }
}

export function shouldRunDraw(schedule: Partial<DropScheduleConfig> | undefined, lastAutoAt: number | null | undefined, now: number = Date.now()): boolean {
  const intervalMs = getDrawIntervalMs(schedule);
  if (intervalMs === null || intervalMs <= 0) return true;
  if (!lastAutoAt || Number(lastAutoAt) <= 0) return true;
  return now - Number(lastAutoAt) >= intervalMs;
}
export function getProductBySlug(config: StorefrontConfig, slug: string): StorefrontProduct | undefined {
  return config.productCatalog.find((product) => product.slug === slug);
}
function findPriceCategory(product: StorefrontProduct, size: string) {
  const categories = Array.isArray(product.priceCategories) ? product.priceCategories : [];
  const normalizedSize = String(size || '').trim();
  return categories.find((category) => String(category?.size || '').trim() === normalizedSize) || null;
}

/**
 * Sentinel for an unconfigured price. Products created in /admin start at this
 * obviously-wrong value so operators can see at a glance that they must set a
 * real price before publishing. It is NEVER chargeable — every checkout/draw
 * path uses `isConfiguredPrice()` and rejects it.
 */
export const UNCONFIGURED_PRICE_SENTINEL = 9999999;

/**
 * A price is only chargeable when it is a finite number, greater than zero,
 * and below the obviously-wrong sentinel. This keeps a product that was never
 * configured (or was configured with a placeholder) from being charged.
 */
export function isConfiguredPrice(price: unknown): boolean {
  const numeric = Number(price);
  return Number.isFinite(numeric) && numeric > 0 && numeric < UNCONFIGURED_PRICE_SENTINEL;
}

// Per-size checkout mode ("a product can be BOTH a raffle and a direct-sale"):
// shared by the storefront, checkout routes and the auto-draw engine. The
// implementation lives in lib/checkout-mode.ts (self-contained for the node
// test runner); this re-export keeps every existing `@/lib/storefront-config`
// import working.
export { getSizeCheckoutMode, hasMixedCheckoutModes, sizeCheckoutModes } from './checkout-mode';

export function getProductPrice(product: StorefrontProduct, size: string): number {
  const category = findPriceCategory(product, size);
  if (category && Number.isFinite(Number(category.price))) {
    const categoryPrice = Number(category.price);
    if (!isConfiguredPrice(categoryPrice)) return 0;
    return Math.max(0, categoryPrice);
  }

  // Legacy fallback for older Redis records that still store fixed size fields.
  const price = size === '100ml' ? product.price100ml : product.price50ml;
  const numericPrice = typeof price === 'number' ? price : 0;
  if (!isConfiguredPrice(numericPrice)) return 0;
  return Math.max(0, numericPrice);
}
export function getProductStripeId(product: StorefrontProduct, size: string): string {
  const category = findPriceCategory(product, size);
  if (category) {
    const categoryStripeId = typeof (category as any).stripeId === 'string'
      ? (category as any).stripeId
      : (typeof (category as any).stripePriceId === 'string' ? (category as any).stripePriceId : '');
    if (categoryStripeId.trim()) return categoryStripeId.trim();
  }

  // Legacy fallback for older Redis records.
  const stripeId = size === '100ml' ? product.stripeId100ml : product.stripeId50ml;
  return typeof stripeId === 'string' ? stripeId : '';
}
export function getWinnerCount(config: StorefrontConfig, size: string): number {
  const count = size === '100ml' ? config.dropSchedule.winnersPer100ml : config.dropSchedule.winnersPer50ml;
  // Default to 0 if not properly set
  return Math.max(0, count || 0);
}
export function getAvailableSizes(config: StorefrontConfig): string[] {
  return config.availableSizes?.length ? config.availableSizes : ['Standard'];
}

export function resolveProductSchedule(config: StorefrontConfig, product: StorefrontProduct): DropScheduleConfig {
  return { ...config.dropSchedule, ...(product.customDropSchedule ?? {}) };
}

function zonedTimeToTimestamp(opts: {
  timezone: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}): number {
  const { timezone, year, month, day, hour, minute } = opts;
  const second = Math.max(0, Math.min(59, Number(opts.second) || 0));
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcGuess));
  const map: Record<string, string> = {};
  parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
  const asIfUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second || 0),
  );
  const offset = asIfUTC - utcGuess;
  return utcGuess - offset;
}

function parseISOLocal(iso: string) {
  const [datePart, timePart] = iso.split('T');
  const [year, month, day] = (datePart || '').split('-').map(Number);
  const timeBits = (timePart || '00:00:00').split(':').map(Number);
  const hour = timeBits[0] || 0;
  const minute = timeBits[1] || 0;
  const second = timeBits[2] || 0;
  return { year, month, day, hour, minute, second };
}

function daysInMonth(year: number, month: number): number {
  // Date(year, month, 0) rolls back to the last day of the PREVIOUS month
  // relative to `month` — since `month` here is 1-based, this correctly
  // gives the last day of the month we actually want.
  return new Date(year, month, 0).getDate();
}

export function scheduledDateToTimestamp(isoWallClock: string, timezone: string): number {
  const parsed = parseISOLocal(isoWallClock);
  const isInvalid =
    Number.isNaN(parsed.year) || Number.isNaN(parsed.month) || Number.isNaN(parsed.day) ||
    Number.isNaN(parsed.hour) || Number.isNaN(parsed.minute);
  if (isInvalid) {
    console.warn(
      `[GOYUNIR] Invalid fixed drop date "${isoWallClock}". Expected format: YYYY-MM-DDTHH:MM:SS ` +
      `(e.g. 2026-07-31T21:00:00). Falling back to 24 hours from now so the site doesn't break.`,
    );
    return Date.now() + 24 * 60 * 60 * 1000;
  }
  return zonedTimeToTimestamp({ timezone, ...parsed });
}

export function getNextDrawTimestampForSchedule(schedule: DropScheduleConfig, afterMs: number = Date.now()): number {
  if (schedule.mode === 'fixed') {
    return scheduledDateToTimestamp(schedule.targetEndDateTime, schedule.timezone);
  }

  if (schedule.mode === 'custom') {
    const intervalMs = getDrawIntervalMs(schedule);
    if (intervalMs === null || intervalMs <= 0) return afterMs + 24 * 60 * 60 * 1000;
    // Rolling fixed-interval cycles: the next draw is `interval` after the
    // base. When the base (the previous cycle end) has slipped into the past
    // (missed draws / stale releaseEndsAt), roll forward to the next multiple
    // so the new timer is always in the future.
    const base = Number.isFinite(afterMs) && afterMs > 0 ? afterMs : Date.now();
    let next = base + intervalMs;
    const now = Date.now();
    if (next <= now) {
      const cycles = Math.floor((now - base) / intervalMs) + 1;
      next = base + cycles * intervalMs;
    }
    return next;
  }

  const now = new Date(afterMs);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    hourCycle: 'h23',
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const parts = dtf.formatToParts(now);
  const map: Record<string, string> = {};
  parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);

  if (schedule.mode === 'hourly') {
    let candidate = zonedTimeToTimestamp({
      timezone: schedule.timezone,
      year,
      month,
      day,
      hour,
      minute: schedule.drawMinute,
      second: schedule.drawSecond ?? 0,
    });
    if (candidate <= now.getTime()) {
      candidate = zonedTimeToTimestamp({
        timezone: schedule.timezone,
        year,
        month,
        day,
        hour: hour + 1,
        minute: schedule.drawMinute,
        second: schedule.drawSecond ?? 0,
      });
    }
    return candidate;
  }

  if (schedule.mode === 'daily') {
    let candidate = zonedTimeToTimestamp({
      timezone: schedule.timezone, year, month, day,
      hour: schedule.drawHour, minute: schedule.drawMinute, second: schedule.drawSecond ?? 0,
    });
    if (candidate <= now.getTime()) {
      candidate = zonedTimeToTimestamp({
        timezone: schedule.timezone, year, month, day: day + 1,
        hour: schedule.drawHour, minute: schedule.drawMinute, second: schedule.drawSecond ?? 0,
      });
    }
    return candidate;
  }

  if (schedule.mode === 'monthly') {
    const clampedDay = Math.min(Math.max(1, schedule.drawDayOfMonth || 1), daysInMonth(year, month));
    let candidate = zonedTimeToTimestamp({
      timezone: schedule.timezone, year, month, day: clampedDay,
      hour: schedule.drawHour, minute: schedule.drawMinute, second: schedule.drawSecond ?? 0,
    });
    if (candidate <= now.getTime()) {
      let nextMonth = month + 1;
      let nextYear = year;
      if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
      const nextClampedDay = Math.min(Math.max(1, schedule.drawDayOfMonth || 1), daysInMonth(nextYear, nextMonth));
      candidate = zonedTimeToTimestamp({
        timezone: schedule.timezone, year: nextYear, month: nextMonth, day: nextClampedDay,
        hour: schedule.drawHour, minute: schedule.drawMinute, second: schedule.drawSecond ?? 0,
      });
    }
    return candidate;
  }

  if (schedule.mode === 'yearly') {
    const anchor = parseISOLocal(schedule.targetEndDateTime);
    const anchorMonth = Math.min(Math.max(1, anchor.month || 1), 12);
    const anchorDay = Math.min(Math.max(1, anchor.day || 1), daysInMonth(year, anchorMonth));
    let candidate = zonedTimeToTimestamp({
      timezone: schedule.timezone,
      year,
      month: anchorMonth,
      day: anchorDay,
      hour: anchor.hour || 0,
      minute: anchor.minute || 0,
      second: anchor.second || 0,
    });
    if (candidate <= now.getTime()) {
      const nextYear = year + 1;
      const nextAnchorDay = Math.min(Math.max(1, anchor.day || 1), daysInMonth(nextYear, anchorMonth));
      candidate = zonedTimeToTimestamp({
        timezone: schedule.timezone,
        year: nextYear,
        month: anchorMonth,
        day: nextAnchorDay,
        hour: anchor.hour || 0,
        minute: anchor.minute || 0,
        second: anchor.second || 0,
      });
    }
    return candidate;
  }

  if (schedule.mode === 'biweekly') {
    const anchor = scheduledDateToTimestamp(schedule.targetEndDateTime, schedule.timezone);
    const intervalMs = 14 * 24 * 60 * 60 * 1000;
    if (anchor > now.getTime()) return anchor;
    const elapsed = now.getTime() - anchor;
    const cycles = Math.floor(elapsed / intervalMs) + 1;
    return anchor + (cycles * intervalMs);
  }

  // 'weekly' (default)
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentDay = weekdayMap[map.weekday];
  const daysUntil = (schedule.drawDayOfWeek - currentDay + 7) % 7;
  let candidate = zonedTimeToTimestamp({
    timezone: schedule.timezone, year, month, day: day + daysUntil,
    hour: schedule.drawHour, minute: schedule.drawMinute, second: schedule.drawSecond ?? 0,
  });
  if (candidate <= now.getTime()) {
    candidate = zonedTimeToTimestamp({
      timezone: schedule.timezone, year, month, day: day + daysUntil + 7,
      hour: schedule.drawHour, minute: schedule.drawMinute, second: schedule.drawSecond ?? 0,
    });
  }
  return candidate;
}

export function getNextDrawTimestamp(config: StorefrontConfig): number {
  return getNextDrawTimestampForSchedule(config.dropSchedule);
}

/**
 * Next recurring draw moment for a schedule, STRICTLY after `afterMs`.
 *
 * Unlike `getNextDrawTimestampForSchedule` (which is used for countdown
 * fallbacks and may legitimately return a past `fixed` target), this helper
 * drives the RAFFLE CYCLE: it returns `null` when the schedule cannot produce
 * a future draw (a one-shot `fixed` date that has already passed), which tells
 * the caller the product should NOT start a new raffle round.
 */
export function getNextRecurringAnchorMs(schedule: DropScheduleConfig, afterMs: number): number | null {
  if (schedule.mode === 'fixed') {
    const target = scheduledDateToTimestamp(schedule.targetEndDateTime, schedule.timezone);
    return target > afterMs ? target : null;
  }
  const next = getNextDrawTimestampForSchedule(schedule, afterMs);
  return Number.isFinite(next) && next > afterMs ? next : null;
}

/**
 * The countdown anchor the storefront should show for a product RIGHT NOW.
 *
 * - While the product's own `releaseEndsAt` is still in the future, that IS
 *   the anchor (the current raffle round is counting down to it).
 * - Once it has passed and the product still has inventory (and is not
 *   archived), the product is a RECURRING raffle: the anchor becomes the next
 *   scheduled draw time (per the effective schedule — global + per-product
 *   overrides), so the UI shows the NEW timer instead of freezing on
 *   "Raffle closed" / "Until sold out".
 * - Sold-out/archived products and one-shot drops whose date passed return
 *   `null` (no future raffle).
 */
export function resolveNextRaffleAnchorMs(
  product: any,
  schedule: DropScheduleConfig,
  now: number = Date.now(),
): number | null {
  const explicitMs = product?.releaseEndsAt
    ? dropTimestampToMs(product.releaseEndsAt, schedule.timezone)
    : null;
  if (explicitMs !== null && explicitMs > now) return explicitMs;
  if (product?.soldOut === true || product?.isArchived === true) return null;
  const base = explicitMs !== null && explicitMs > 0 ? explicitMs : now;
  return getNextRecurringAnchorMs(schedule, base);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-size raffle configuration — "customize each raffle differently."
// Implementation lives in lib/size-configs.ts (self-contained so the node
// --test runner can load it); this re-export keeps every `@/lib/storefront-config`
// import working while `resolveSizeNextAnchorMs` below composes the pure helpers
// with the recurring-anchor math that lives in this module.
// ─────────────────────────────────────────────────────────────────────────────

export type { SizeRaffleConfig } from './size-configs';
export {
  sizeConfigKey,
  sizeConfigsOf,
  getSizeReleaseEndsAt,
  getSizeCustomSchedule,
  resolveSizeReleaseEndsAt,
  resolveSizeSchedule,
  normalizeSizeConfigs,
} from './size-configs';
// Local bindings for the anchor composition below (the `export ... from` above
// re-exports without binding locally).
import { resolveSizeReleaseEndsAt, resolveSizeSchedule } from './size-configs';

/**
 * The countdown anchor ONE size should show RIGHT NOW — per-size equivalent of
 * `resolveNextRaffleAnchorMs`. While the size's own end is still in the future
 * that IS the anchor; once it passes (inventory remains + a recurring schedule)
 * the anchor becomes the size's next scheduled draw moment; sold-out/one-shot
 * ended sizes return `null` (no future raffle for that size).
 */
export function resolveSizeNextAnchorMs(
  product: any,
  size: string,
  globalSchedule: Partial<DropScheduleConfig> | Record<string, any>,
  now: number = Date.now(),
): number | null {
  const schedule = resolveSizeSchedule(product, size, globalSchedule);
  const explicit = resolveSizeReleaseEndsAt(product, size);
  const explicitMs = explicit ? dropTimestampToMs(explicit, schedule.timezone) : null;
  if (explicitMs !== null && explicitMs > now) return explicitMs;
  if (product?.soldOut === true || product?.isArchived === true) return null;
  const base = explicitMs !== null && explicitMs > 0 ? explicitMs : now;
  return getNextRecurringAnchorMs(schedule, base);
}