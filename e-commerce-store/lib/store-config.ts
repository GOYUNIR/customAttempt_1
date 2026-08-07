import { createRedisClient } from './server-config';

export interface StoreConfig {
  themeColors: {
    primaryBackground: string;
    cardBackground: string;
    cardBorder: string;
    accentPurple: string;
    accentBlue: string;
    textMain: string;
    textMuted: string;
    checkoutCtaButton: string;
  };
  availableSizes: string[];
  homeRedirectSlug?: string;
  dropSchedule: {
    mode: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';
    timezone: string;
    targetEndDateTime: string;
    drawDayOfWeek: number;
    drawDayOfMonth: number;
    drawHour: number;
    drawMinute: number;
    drawSecond?: number;
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
  };
  socialProof: {
    label: string;
    baseCount: number;
    caption: string;
    autoIncrementEnabled: boolean;
    autoIncrementChancePerHeartbeat: number;
    autoIncrementAmount: number;
    autoIncrementMaxPerDay: number;
    autoIncrementMinHourGap: number;
  };
  brandFooterData: {
    instagramLink: string;
    tiktokLink: string;
    supportEmail: string;
    shippingReturnPolicyText: string;
    corporateEntityCopyright: string;
  };
  catalogPreview: {
    upcomingDrops: any[];
    archiveScents: any[];
  };
  productCatalog: any[];
}

const DEFAULT_CONFIG: Partial<StoreConfig> = {
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
    eyebrow: 'The Architecture of Scent',
    headline: 'A drop that moves faster than attention itself.',
    body: 'We design fragrances that move faster than time itself.',
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
    upcomingDrops: [],
    archiveScents: [],
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
    const configRaw = await redis.get('store:config');
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