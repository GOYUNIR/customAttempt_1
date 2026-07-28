export interface StorefrontNote {
  label: string;
  name: string;
  text: string;
}

export interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  prefix: string;
  tagline: string;
  desc: string;
  price50ml: number;
  price100ml: number;
  stripeId50ml: string;
  stripeId100ml: string;
  maxRaffleAllocationLimit: number;
  isActive?: boolean;
  accent?: string;
  notes: StorefrontNote[];
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
    checkoutCtaButton: string;
  };
  dropSchedule: {
    targetEndDateTime: string;
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
    value: string;
    caption: string;
  };
  brandFooterData: {
    instagramLink: string;
    tiktokLink: string;
    supportEmail: string;
    shippingReturnPolicyText: string;
    corporateEntityCopyright: string;
  };
  productCatalog: StorefrontProduct[];
}

const defaultThemeColors = {
  primaryBackground: '#0a0a0a',
  cardBackground: '#111111',
  cardBorder: '#222222',
  accentPurple: '#a855f7',
  accentBlue: '#3b82f6',
  textMain: '#ffffff',
  textMuted: '#888888',
  checkoutCtaButton: '#635bff',
};

const defaultDropSchedule = {
  targetEndDateTime: '2026-07-27T19:30:00',
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
  eyebrow: 'The Architecture of Scent',
  headline: 'A drop that moves faster than attention itself.',
  body: 'We design fragrances that move faster than time itself. An intentional collision of raw natural essences and electric modern chemistry.',
  ctaLabel: '↓ Scroll To Explore',
};

const defaultSocialProof = {
  label: 'Limited drop access',
  value: '1,287 early entrants',
  caption: 'Hype is compounding fast—reserve now before inventory closes.',
};

const defaultFooter = {
  instagramLink: 'https://instagram.com/goyunir',
  tiktokLink: 'https://tiktok.com/goyunir',
  supportEmail: 'goyunir.support@gmail.com',
  shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
  corporateEntityCopyright: 'GOYUNIR ALL RIGHTS RESERVED.',
};

function normalizeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeProduct(product: Partial<StorefrontProduct> & { id?: string }, index: number): StorefrontProduct {
  const fallbackName = `Perfume ${index + 1}`;
  const fallbackSlug = `${product.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return {
    id: normalizeText(product.id, `p${index + 1}`),
    name: normalizeText(product.name, fallbackName),
    slug: normalizeText(product.slug, fallbackSlug),
    prefix: normalizeText(product.prefix, `EXAMPLEPIC${index + 1}`),
    tagline: normalizeText(product.tagline, 'LIMITED DROP'),
    desc: normalizeText(product.desc, 'A refined signature profile for the next allocation window.'),
    price50ml: normalizeNumber(product.price50ml, 85),
    price100ml: normalizeNumber(product.price100ml, 140),
    stripeId50ml: normalizeText(product.stripeId50ml, 'price_placeholder_50'),
    stripeId100ml: normalizeText(product.stripeId100ml, 'price_placeholder_100'),
    maxRaffleAllocationLimit: normalizeNumber(product.maxRaffleAllocationLimit, 10),
    isActive: product.isActive ?? true,
    accent: normalizeText(product.accent, ''),
    notes: (product.notes ?? []).map((note) => ({
      label: normalizeText(note?.label, 'PROFILE'),
      name: normalizeText(note?.name, 'Signature Note'),
      text: normalizeText(note?.text, 'A polished profile note designed for instant recognition.'),
    })),
  };
}

export function buildStorefrontConfig(input: Partial<StorefrontConfig> = {}): StorefrontConfig {
  const productCatalog = Array.isArray(input.productCatalog)
    ? input.productCatalog.filter(Boolean).map((product, index) => normalizeProduct(product as Partial<StorefrontProduct> & { id?: string }, index))
    : [];

  return {
    themeColors: {
      ...defaultThemeColors,
      ...(input.themeColors ?? {}),
    },
    dropSchedule: {
      ...defaultDropSchedule,
      ...(input.dropSchedule ?? {}),
    },
    animationMechanics: {
      ...defaultAnimationMechanics,
      ...(input.animationMechanics ?? {}),
    },
    raffleRegistrationForm: {
      ...defaultFormCopy,
      ...(input.raffleRegistrationForm ?? {}),
    },
    heroContent: {
      ...defaultHeroContent,
      ...(input.heroContent ?? {}),
    },
    socialProof: {
      ...defaultSocialProof,
      ...(input.socialProof ?? {}),
    },
    brandFooterData: {
      ...defaultFooter,
      ...(input.brandFooterData ?? {}),
    },
    productCatalog,
  };
}

export function getVisibleProducts(config: StorefrontConfig): StorefrontProduct[] {
  return config.productCatalog.filter((product) => product.isActive !== false);
}

export function getProductBySlug(config: StorefrontConfig, slug: string): StorefrontProduct | undefined {
  return getVisibleProducts(config).find((product) => product.slug === slug);
}

export function getProductPrice(product: StorefrontProduct, size: string): number {
  return size === '100ml' ? product.price100ml : product.price50ml;
}

export function getProductStripeId(product: StorefrontProduct, size: string): string {
  return size === '100ml' ? product.stripeId100ml : product.stripeId50ml;
}

export function getWinnerCount(config: StorefrontConfig, size: string): number {
  return size === '100ml' ? config.dropSchedule.winnersPer100ml : config.dropSchedule.winnersPer50ml;
}
