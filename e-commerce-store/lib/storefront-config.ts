export interface StorefrontNote {
  label: string;
  name: string;
  text: string;
}

export interface DropScheduleConfig {
  mode: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  timezone: string;
  targetEndDateTime: string; // used when mode is 'fixed', and as the anchor date/time for 'biweekly' and 'yearly'
  drawDayOfWeek: number;     // 0=Sun...6=Sat, used when mode is 'weekly'
  drawDayOfMonth: number;    // 1-31, used when mode is 'monthly' (clamped to the last real day of shorter months)
  drawHour: number;          // used by 'hourly' / 'daily' / 'weekly' / 'monthly'
  drawMinute: number;
  /** 0-59, used by hourly/daily/weekly/monthly (optional, default 0) */
  drawSecond?: number;
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
  topBar: OrbVisualConfig;
  primary: OrbVisualConfig;
  secondary: OrbVisualConfig;
  tertiary: OrbVisualConfig;
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
    checkoutCtaButton: string;
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
  };
  socialProof: {
    label: string;
    baseCount: number;
    caption: string;
    autoIncrementEnabled: boolean;
    autoIncrementChancePerHeartbeat: number;
    autoIncrementAmount: number;
    // "x times a day, x hour threshold" controls for the /api/analytics/social-tick cron:
    autoIncrementMaxPerDay: number;   // hard cap on how many times/day it can tick up
    autoIncrementMinHourGap: number;  // minimum hours between ticks
    autoIncrementMaxHourGap: number;  // force a tick when stale beyond this threshold
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
  orbs: OrbsConfig;
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
  autoIncrementMaxPerDay: 4,
  autoIncrementMinHourGap: 3,
  autoIncrementMaxHourGap: 8,
};

const defaultFooter = {
  instagramLink: 'https://instagram.com/goyunir',
  tiktokLink: 'https://tiktok.com/goyunir',
  supportEmail: 'goyunir.support@gmail.com',
  shippingReturnPolicyText: 'Shipping & Returns Policy Apply.',
  corporateEntityCopyright: 'GOYUNIR ALL RIGHTS RESERVED.',
};

// Default orb system — background glow orbs plus the animated top-bar orb.
// Every value here is editable live from /admin → Settings → Orb Glow.
const defaultOrbs: OrbsConfig = {
  enabled: true,
  topBar: { enabled: true, color: '#7dd3fc', opacity: 34, size: 210 },
  primary: { enabled: true, color: '#3b82f6', opacity: 16, size: 58 },
  secondary: { enabled: true, color: '#a855f7', opacity: 26, size: 44 },
  tertiary: { enabled: true, color: '#ffd79b', opacity: 12, size: 28 },
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
    : [{ size: fallbackSize, price: 0, stripeId: '', winnerTiers: '0' }];

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
    customDropSchedule: product.customDropSchedule,
    scheduledArchiveAt: product.scheduledArchiveAt,
    scheduledUnarchiveAt: product.scheduledUnarchiveAt,
    catalogImage: product.catalogImage,
    totalInventory: product.totalInventory,
    winnerTiers: product.winnerTiers,
  };
}

/** Deep-merge a stored (partial) orbs config over the defaults. */
export function mergeOrbsConfig(input?: Partial<OrbsConfig> | null): OrbsConfig {
  if (!input) return defaultOrbs;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaultOrbs.enabled,
    topBar: { ...defaultOrbs.topBar, ...(input.topBar || {}) },
    primary: { ...defaultOrbs.primary, ...(input.primary || {}) },
    secondary: { ...defaultOrbs.secondary, ...(input.secondary || {}) },
    tertiary: { ...defaultOrbs.tertiary, ...(input.tertiary || {}) },
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
    orbs: mergeOrbsConfig(input.orbs),
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

export function getProductPrice(product: StorefrontProduct, size: string): number {
  const category = findPriceCategory(product, size);
  if (category && Number.isFinite(Number(category.price))) {
    const categoryPrice = Number(category.price);
    if (categoryPrice > 999999) return 0;
    return Math.max(0, categoryPrice);
  }

  // Legacy fallback for older Redis records that still store fixed size fields.
  const price = size === '100ml' ? product.price100ml : product.price50ml;
  const numericPrice = typeof price === 'number' ? price : 0;
  if (numericPrice > 999999) return 0;
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

export function getNextDrawTimestampForSchedule(schedule: DropScheduleConfig): number {
  if (schedule.mode === 'fixed') {
    return scheduledDateToTimestamp(schedule.targetEndDateTime, schedule.timezone);
  }

  const now = new Date();
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
  let daysUntil = (schedule.drawDayOfWeek - currentDay + 7) % 7;
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