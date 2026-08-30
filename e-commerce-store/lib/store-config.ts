import { createRedisClient } from './server-config';
import { mergeOrbsConfig } from './storefront-config';
import { STORE_CONFIG_KEY } from './redis-keys';

export interface OrbVisualConfig {
  enabled: boolean;
  color: string;
  opacity: number;
  size: number;
}

export interface OrbMotionConfig {
  idleEnabled: boolean;
  pointerEnabled: boolean;
  scrollEnabled: boolean;
  intensity: number;
  speed: number;
  momentum: number;
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

export interface StoreConfig {
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
    /** Top-bar background — empty = derived from cardBackground + chrome transparency. */
    headerBackground?: string;
    /** Top-bar text/icon color — empty = auto-picked from the header background. */
    headerText?: string;
    fontFamily?: string;
    borderRadius?: number;
    /** Header/footer/cart-drawer opacity (0-100) — set from /admin → Settings. */
    chromeTransparency?: number;
    /** Card/surface opacity (0-100) — set from /admin → Settings. */
    surfaceTransparency?: number;
    /** Corner style: 'squircle' (default) | 'rounded' | 'sharp'. */
    radiusStyle?: 'squircle' | 'rounded' | 'sharp';
    /** Soft card shadow intensity (0-100). */
    cardShadow?: number;
    /** Frosted-glass backdrop blur (0-100) for chrome surfaces. */
    backdropBlur?: number;
    /** Page rhythm: 'compact' | 'comfortable' (default) | 'spacious'. */
    contentSpacing?: 'compact' | 'comfortable' | 'spacious';
  };
  availableSizes: string[];
  homeRedirectSlug?: string;
  dropSchedule: {
    mode: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
    timezone: string;
    targetEndDateTime: string;
    drawDayOfWeek: number;
    drawDayOfMonth: number;
    drawHour: number;
    drawMinute: number;
    drawSecond?: number;
    customIntervalHours?: number;
    countdownExpiredText: string;
    daysLabel: string;
    hoursLabel: string;
    minutesLabel: string;
    secondsLabel: string;
    winnersPer50ml: number;
    winnersPer100ml: number;
  };
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
    /** Per-element show/hide toggles (default ALL on). */
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
    autoIncrementMaxPerDay: number;
    autoIncrementMinPerDay: number;
    autoIncrementMinHourGap: number;
    autoIncrementMaxHourGap: number;
    /** Show the whole counter (default true). */
    showSection?: boolean;
    /** Show the caption line (default true). */
    showCaption?: boolean;
  };
  brandFooterData: {
    instagramLink: string;
    tiktokLink: string;
    supportEmail: string;
    shippingReturnPolicyText: string;
    corporateEntityCopyright: string;
    /** Show the footer tagline (default true). */
    showTagline?: boolean;
  };
  catalogPreview: {
    upcomingDrops: any[];
    archiveScents: any[];
  };
  /** Catalog presentation settings (section order on /catalog). */
  catalog?: {
    /** Order of the /catalog sections: 'live' | 'upcoming' | 'archive'. */
    sectionOrder?: string[];
    /** Admin-managed product categories (Settings → Catalog → Categories).
     *  Products are tagged with any subset; buyers add/rename/delete freely. */
    categories?: string[];
  };
  /**
   * Site behaviour switches (admin → Settings → Behavior). Currently controls
   * whether the storefront forces the page to start at the TOP on every load
   * (default ON) instead of letting the browser restore the last scroll
   * position mid-page.
   */
  behavior?: {
    /** Start at the top of the page on load (true) or restore the browser's saved scroll (false). */
    scrollToTopOnLoad?: boolean;
  };
  /** Checkout & orders policy (admin → Settings → Checkout & Orders). */
  checkout?: {
    /** When ON (default), customer "update address" flows require the FULL
     *  Mapbox-dropdown address — a partial address can never be saved. The
     *  admin portal can override and save a partial address regardless. */
    requireAddressAutofill?: boolean;
  };
  /** Home-page layout (admin → Settings → Home Layout). */
  layout?: {
    /** Number of featured products per row on the home page: 1 = full width,
     *  2 = two side by side (default). */
    productsPerRow?: 1 | 2;
    /** What the home page shows when there are NO active releases:
     *  'none' (empty), 'upcoming' (build hype), 'archived', or
     *  'upcoming_then_archived'. Defaults to 'upcoming' so an empty catalog
     *  still shows the next drop instead of a blank site. */
    homepageFallback?: string;
  };
  orbs: OrbsConfig;
  productCatalog: any[];
}

const DEFAULT_CONFIG: Partial<StoreConfig> = {
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
    // Top bar colors — empty = auto (derived from cardBackground + chrome alpha).
    headerBackground: '',
    headerText: '',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    borderRadius: 24,
    // Transparency (0-100): chrome = header/footer/drawer, surface = cards.
    chromeTransparency: 62,
    surfaceTransparency: 98,
    radiusStyle: 'squircle',
    cardShadow: 14,
    backdropBlur: 80,
    contentSpacing: 'comfortable',
  },
  availableSizes: ['Standard'],
  dropSchedule: {
    mode: 'weekly',
    timezone: 'America/Los_Angeles',
    targetEndDateTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', 'T') + ':00',
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
    winnersPer50ml: 0,
    winnersPer100ml: 0,
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
    showEyebrow: true,
    showHeadline: true,
    showBody: true,
    showCta: true,
    showStory: true,
  },
  socialProof: {
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
  },
  brandFooterData: {
    instagramLink: '',
    tiktokLink: '',
    supportEmail: '',
    shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
    corporateEntityCopyright: 'ALL RIGHTS RESERVED.',
    showTagline: true,
  },
  catalogPreview: {
    upcomingDrops: [],
    archiveScents: [],
  },
  // Default /catalog section order: live at the BOTTOM (per the template
  // default) — operators can reorder from /admin → Settings → Catalog.
  // `categories` is the seeded admin-managed list (Settings → Catalog →
  // Categories); buyers add/rename/delete freely and tag products with any
  // subset.
  catalog: {
    sectionOrder: ['upcoming', 'archive', 'live'],
    // Categories are EMPTY by default — they only exist after the admin runs
    // Seed Defaults (the seed writes this list into Redis). An unseeded store
    // deliberately has no categories.
    categories: [],
  },
  checkout: {
    requireAddressAutofill: true,
  },
  layout: {
    productsPerRow: 2,
    homepageFallback: 'upcoming',
  },
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
  productCatalog: [],
};

export async function getStoreConfig(redis?: any): Promise<StoreConfig> {
  if (!redis) {
    redis = createRedisClient();
  }
  
  if (!redis) {
    return DEFAULT_CONFIG as StoreConfig;
  }

  try {
    const configRaw = await redis.get(STORE_CONFIG_KEY);
    const config = safeParseRedisItem<any>(configRaw) || {};
    
    // Merge with defaults
    return {
      ...DEFAULT_CONFIG,
      ...config,
      themeColors: { ...DEFAULT_CONFIG.themeColors, ...config.themeColors },
      dropSchedule: { ...DEFAULT_CONFIG.dropSchedule, ...config.dropSchedule },
      animationMechanics: { ...DEFAULT_CONFIG.animationMechanics, ...config.animationMechanics },
      raffleRegistrationForm: { ...DEFAULT_CONFIG.raffleRegistrationForm, ...config.raffleRegistrationForm },
      heroContent: { ...DEFAULT_CONFIG.heroContent, ...config.heroContent },
      socialProof: { ...DEFAULT_CONFIG.socialProof, ...config.socialProof },
      brandFooterData: { ...DEFAULT_CONFIG.brandFooterData, ...config.brandFooterData },
      catalogPreview: { ...DEFAULT_CONFIG.catalogPreview, ...config.catalogPreview },
      catalog: { ...DEFAULT_CONFIG.catalog, ...config.catalog },
      checkout: { ...DEFAULT_CONFIG.checkout, ...config.checkout },
      layout: { ...DEFAULT_CONFIG.layout, ...config.layout },
      orbs: mergeOrbsConfig(config.orbs),
    } as StoreConfig;
  } catch {
    return DEFAULT_CONFIG as StoreConfig;
  }
}

export function safeParseRedisItem<T = any>(item: unknown): T | null {
  if (item == null) return null;
  if (typeof item === 'object') return item as T;
  if (typeof item === 'string') {
    try {
      return JSON.parse(item) as T;
    } catch {
      return null;
    }
  }
  return null;
}