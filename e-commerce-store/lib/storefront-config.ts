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

export interface CatalogPreviewItem {
  name: string;
  status: string;
  eta?: string;
  image?: string;
  description?: string;
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
    mode: 'fixed' | 'weekly';
    targetEndDateTime: string;
    drawDayOfWeekUTC: number;
    drawHourUTC: number;
    drawMinuteUTC: number;
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
    baseCount: number;
    caption: string;
    autoIncrementEnabled: boolean;
    autoIncrementChancePerHeartbeat: number;
    autoIncrementAmount: number;
  };
  brandFooterData: {
    instagramLink: string;
    tiktokLink: string;
    supportEmail: string;
    shippingReturnPolicyText: string;
    corporateEntityCopyright: string;
  };
  catalogPreview: {
    upcomingDrops: CatalogPreviewItem[];
    archiveScents: CatalogPreviewItem[];
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
  mode: 'weekly' as const,
  targetEndDateTime: '2026-07-27T19:30:00',
  drawDayOfWeekUTC: 6, // 0=Sun ... 6=Sat
  drawHourUTC: 4, // adjust to match your audience's timezone
  drawMinuteUTC: 0,
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
  baseCount: 0,
  caption: 'Hype is compounding fast—reserve now before inventory closes.',
  autoIncrementEnabled: true,
  autoIncrementChancePerHeartbeat: 0.15,
  autoIncrementAmount: 1,
};

const defaultFooter = {
  instagramLink: 'https://instagram.com/goyunir',
  tiktokLink: 'https://tiktok.com/goyunir',
  supportEmail: 'goyunir.support@gmail.com',
  shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
  corporateEntityCopyright: 'GOYUNIR ALL RIGHTS RESERVED.',
};

const defaultCatalogPreview = {
  upcomingDrops: [] as CatalogPreviewItem[],
  archiveScents: [] as CatalogPreviewItem[],
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
  }));
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
    themeColors: { ...defaultThemeColors, ...(input.themeColors ?? {}) },
    dropSchedule: { ...defaultDropSchedule, ...(input.dropSchedule ?? {}) },
    animationMechanics: { ...defaultAnimationMechanics, ...(input.animationMechanics ?? {}) },
    raffleRegistrationForm: { ...defaultFormCopy, ...(input.raffleRegistrationForm ?? {}) },
    heroContent: { ...defaultHeroContent, ...(input.heroContent ?? {}) },
    socialProof: { ...defaultSocialProof, ...(input.socialProof ?? {}) },
    brandFooterData: { ...defaultFooter, ...(input.brandFooterData ?? {}) },
    catalogPreview: {
      upcomingDrops: normalizeCatalogItems(input.catalogPreview?.upcomingDrops) ?? defaultCatalogPreview.upcomingDrops,
      archiveScents: normalizeCatalogItems(input.catalogPreview?.archiveScents) ?? defaultCatalogPreview.archiveScents,
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

// Computes the next draw timestamp. In 'weekly' mode it finds the next
// occurrence of the configured weekday/time; in 'fixed' mode it uses the
// exact date you set. Switch modes any time in goyunir.config.ts.
export function getNextDrawTimestamp(config: StorefrontConfig): number {
  if (config.dropSchedule.mode === 'fixed') {
    return new Date(config.dropSchedule.targetEndDateTime).getTime();
  }
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(config.dropSchedule.drawHourUTC, config.dropSchedule.drawMinuteUTC, 0, 0);
  const currentDay = target.getUTCDay();
  let daysUntil = (config.dropSchedule.drawDayOfWeekUTC - currentDay + 7) % 7;
  if (daysUntil === 0 && target.getTime() <= now.getTime()) {
    daysUntil = 7;
  }
  target.setUTCDate(target.getUTCDate() + daysUntil);
  return target.getTime();
}