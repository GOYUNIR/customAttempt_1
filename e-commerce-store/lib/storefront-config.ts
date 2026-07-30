export interface StorefrontNote {
  label: string;
  name: string;
  text: string;
}

export interface DropScheduleConfig {
  mode: 'fixed' | 'weekly';
  timezone: string; // IANA name, e.g. 'America/Los_Angeles'
  targetEndDateTime: string; // wall-clock in `timezone`, used when mode is 'fixed'
  drawDayOfWeek: number; // 0=Sun...6=Sat, wall-clock in `timezone`, used when mode is 'weekly'
  drawHour: number; // 0-23, wall-clock in `timezone`
  drawMinute: number;
  countdownExpiredText: string;
  daysLabel: string;
  hoursLabel: string;
  minutesLabel: string;
  secondsLabel: string;
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
  price50ml: number;
  price100ml: number;
  stripeId50ml: string;
  stripeId100ml: string;
  maxRaffleAllocationLimit: number;
  isActive?: boolean;
  accent?: string;
  notes: StorefrontNote[];
  // Optional per-product schedule override. Any field you omit falls back
  // to the global dropSchedule below.
  customDropSchedule?: Partial<DropScheduleConfig>;
  // Optional auto-archive/unarchive dates, wall-clock in the effective
  // schedule's timezone. Leave blank to manage archiving manually only.
  scheduledArchiveAt?: string;
  scheduledUnarchiveAt?: string;
  catalogImage?: string;
}

export interface CatalogPreviewItem {
  name: string;
  status: string;
  eta?: string;
  image?: string;
  description?: string;
  availableFrom?: string;
  availableUntil?: string;
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

const defaultDropSchedule: DropScheduleConfig = {
  mode: 'weekly',
  timezone: 'America/Los_Angeles',
  targetEndDateTime: '2026-07-27T19:30:00',
  drawDayOfWeek: 6,
  drawHour: 21,
  drawMinute: 0,
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
    availableFrom: typeof item?.availableFrom === 'string' ? item.availableFrom : undefined,
    availableUntil: typeof item?.availableUntil === 'string' ? item.availableUntil : undefined,
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
    customDropSchedule: product.customDropSchedule,
    scheduledArchiveAt: product.scheduledArchiveAt,
    scheduledUnarchiveAt: product.scheduledUnarchiveAt,
    catalogImage: product.catalogImage,
  };
}

export function buildStorefrontConfig(input: Partial<StorefrontConfig> = {}): StorefrontConfig {
  const productCatalog = Array.isArray(input.productCatalog)
    ? input.productCatalog.filter(Boolean).map((product, index) => normalizeProduct(product as any, index))
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
  return config.productCatalog.find((product) => product.slug === slug);
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

export function resolveProductSchedule(config: StorefrontConfig, product: StorefrontProduct): DropScheduleConfig {
  return { ...config.dropSchedule, ...(product.customDropSchedule ?? {}) };
}

// ============================================
// TIMEZONE-AWARE SCHEDULING
// Converts a wall-clock date/time in a given IANA timezone (e.g. PST) into
// an accurate UTC timestamp, using only the built-in Intl API — no extra
// date library needed.
// ============================================
function zonedTimeToTimestamp(opts: { timezone: string; year: number; month: number; day: number; hour: number; minute: number }): number {
  const { timezone, year, month, day, hour, minute } = opts;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcGuess));
  const map: Record<string, string> = {};
  parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
  const asIfUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute));
  const offset = asIfUTC - utcGuess;
  return utcGuess - offset;
}

function parseISOLocal(iso: string) {
  const [datePart, timePart] = iso.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = (timePart || '00:00').split(':').map(Number);
  return { year, month, day, hour, minute };
}

export function scheduledDateToTimestamp(isoWallClock: string, timezone: string): number {
  return zonedTimeToTimestamp({ timezone, ...parseISOLocal(isoWallClock) });
}

export function getNextDrawTimestampForSchedule(schedule: DropScheduleConfig): number {
  if (schedule.mode === 'fixed') {
    return scheduledDateToTimestamp(schedule.targetEndDateTime, schedule.timezone);
  }
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = dtf.formatToParts(now);
  const map: Record<string, string> = {};
  parts.forEach((p) => { if (p.type !== 'literal') map[p.type] = p.value; });
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentDay = weekdayMap[map.weekday];
  let daysUntil = (schedule.drawDayOfWeek - currentDay + 7) % 7;

  let candidate = zonedTimeToTimestamp({
    timezone: schedule.timezone,
    year: Number(map.year), month: Number(map.month), day: Number(map.day) + daysUntil,
    hour: schedule.drawHour, minute: schedule.drawMinute,
  });
  if (candidate <= now.getTime()) {
    candidate = zonedTimeToTimestamp({
      timezone: schedule.timezone,
      year: Number(map.year), month: Number(map.month), day: Number(map.day) + daysUntil + 7,
      hour: schedule.drawHour, minute: schedule.drawMinute,
    });
  }
  return candidate;
}

// Back-compat helper for the global schedule specifically.
export function getNextDrawTimestamp(config: StorefrontConfig): number {
  return getNextDrawTimestampForSchedule(config.dropSchedule);
}