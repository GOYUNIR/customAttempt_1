import { Redis } from '@upstash/redis';
import Stripe from 'stripe';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { withTtlCache } from '@/lib/ttl-cache';
import { UNCONFIGURED_PRICE_SENTINEL } from '@/lib/storefront-config';

export const STORE_CONFIG_KEY = 'store:config';

export type StoreBrandingConfig = {
  logoUrl?: string;
  shareImageUrl?: string;
  shareTitle?: string;
  shareDescription?: string;
  shareBackground?: string;
  shareAccent?: string;
  shareText?: string;
  iconBackground?: string;
  iconText?: string;
};

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

export function resolveCustomerId(entry: any): string {
  return String(entry?.customerId || entry?.stripeCustomerId || '');
}

export const ARCHIVE_LEDGER_KEY = 'archive:ledger';

export interface ArchiveRecord {
  email: string;
  variant: string;
  size: string;
  shippingAddress: string;
  id: string;
  registeredAt: string;
  type: string;
  shippingStatus?: string;
  promoCode?: string;
  amountCents?: number;
  orderRef?: string;
  discountPercent?: number;
}

export async function archiveEntry(redis: Redis, record: ArchiveRecord) {
  try {
    await redis.rpush(ARCHIVE_LEDGER_KEY, JSON.stringify(record));
  } catch {}
}

export async function loadStoreConfig(redis: Redis | null | undefined): Promise<Record<string, any>> {
  if (!redis) return {};
  try {
    return safeParseRedisItem<any>(await redis.get(STORE_CONFIG_KEY)) || {};
  } catch {
    return {};
  }
}

/**
 * Cached variant for public-facing reads (layout metadata, favicon, OG image,
 * storefront theme). Branding/theme changes are documented as requiring a
 * rebuild anyway, so a short TTL here is safe and removes a Redis round trip
 * from every request on warm instances.
 */
export function loadStoreConfigCached(redis: Redis | null | undefined): Promise<Record<string, any>> {
  return withTtlCache('store:config', 30_000, () => loadStoreConfig(redis));
}

export const POOL_STATS_KEY = 'stats:pools';
export function poolStatField(kind: 'sub' | 'int', variant: string, size: string) {
  return `${kind}:${variant}:${size}`;
}

export const SOCIAL_PROOF_BOOST_KEY = 'stats:social_proof_boost';
export const PROCESSED_SESSIONS_KEY = 'drop_processed_sessions';
export const LAST_DRAW_KEY = 'drop_last_draw_summary';
export const CATALOG_ARCHIVE_KEY = 'catalog:archive_state';
export const LIVE_STATE_KEY = 'live_state';
export const PROMOS_KEY = 'config:promos';

export function emailBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:emails`;
}
export function cardBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:cards`;
}

export function liveStateField(productId: string, slug: string, size: string) {
  const safeSlug = String(slug || productId).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${productId}-${safeSlug}:${size}`;
}

export interface LiveStateRecord {
  productId: string;
  sourceProductId?: string;
  productName: string;
  slug: string;
  size: string;
  isActive: boolean;
  totalInventory: number;
  inventoryRemaining: number;
  winnersPerDraw: number;
  drawsCompleted: number;
  salesCompleted: number;
}

/** Resolve the real catalog product id from a live-state record/hash field. */
export function resolveLiveStateSourceProductId(state: Pick<LiveStateRecord, 'productId' | 'sourceProductId' | 'slug'>): string {
  if (state.sourceProductId && String(state.sourceProductId).trim()) {
    return String(state.sourceProductId).trim();
  }

  const field = String(state.productId || '');
  // liveStateField format: `${productId}-${safeSlug}:${size}`
  const colon = field.lastIndexOf(':');
  if (colon > 0) {
    const withoutSize = field.slice(0, colon);
    const slug = String(state.slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (slug && withoutSize.toLowerCase().endsWith(`-${slug}`)) {
      return withoutSize.slice(0, -(slug.length + 1));
    }
    const dash = withoutSize.indexOf('-');
    if (dash > 0) return withoutSize.slice(0, dash);
  }

  return field;
}

export function aggregateLiveInventoryByProduct(
  liveStates: LiveStateRecord[],
): Map<string, { inventoryRemaining: number; totalInventory: number }> {
  const liveStatesByProduct = new Map<string, { inventoryRemaining: number; totalInventory: number }>();
  for (const state of liveStates) {
    const key = resolveLiveStateSourceProductId(state);
    if (!key) continue;
    const existing = liveStatesByProduct.get(key) || { inventoryRemaining: 0, totalInventory: 0 };
    liveStatesByProduct.set(key, {
      inventoryRemaining: existing.inventoryRemaining + Math.max(0, Number(state.inventoryRemaining || 0)),
      totalInventory: existing.totalInventory + Math.max(0, Number(state.totalInventory || 0)),
    });
  }
  return liveStatesByProduct;
}

export function findLiveInventoryForProduct(
  liveStatesByProduct: Map<string, { inventoryRemaining: number; totalInventory: number }>,
  product: { id?: string; slug?: string },
  liveStates?: LiveStateRecord[],
): { inventoryRemaining: number; totalInventory: number } | null {
  const byId = product.id ? liveStatesByProduct.get(String(product.id)) : null;
  if (byId) return byId;

  if (liveStates && product.slug) {
    const matching = liveStates.filter((state) => String(state.slug || '') === String(product.slug));
    if (matching.length > 0) {
      return matching.reduce(
        (acc, state) => ({
          inventoryRemaining: acc.inventoryRemaining + Math.max(0, Number(state.inventoryRemaining || 0)),
          totalInventory: acc.totalInventory + Math.max(0, Number(state.totalInventory || 0)),
        }),
        { inventoryRemaining: 0, totalInventory: 0 },
      );
    }
  }

  return null;
}

function normalizeWinners(value: unknown, fallback = 1): number {
  if (Array.isArray(value)) return Math.max(1, Number(value[0] ?? fallback) || fallback);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, value);
  if (typeof value === 'string' && value.trim()) return Math.max(1, Number(value) || fallback);
  return fallback;
}

export async function getOrSeedLiveState(
  redis: Redis,
  product: { id: string; name: string; slug: string; maxRaffleAllocationLimit: number; totalInventory?: number },
  size: string,
  winnersPerDraw: number,
): Promise<LiveStateRecord> {
  const field = liveStateField(product.id, product.slug, size);
  const raw = await redis.hget(LIVE_STATE_KEY, field);
  const existing = safeParseRedisItem<LiveStateRecord>(raw);
  if (existing && typeof existing.inventoryRemaining === 'number') {
    const storedTotal = Math.max(0, Number(existing.totalInventory) || 0);
    const storedRemaining = Math.max(0, Number(existing.inventoryRemaining) || 0);
    const productStock = Math.max(0, Number(product.totalInventory) || 0);
    const raffleLimit = Math.max(0, Number(product.maxRaffleAllocationLimit) || 0);
    const expectedSeed = raffleLimit > 0 ? raffleLimit : productStock;
    const noActivity =
      Number(existing.salesCompleted || 0) === 0 && Number(existing.drawsCompleted || 0) === 0;

    // Heal stale/zeroed live states. This can happen when a live state was
    // seeded from an older schema or a draft product record. We only refresh
    // when the stored state is completely unconfigured (0 total, 0 remaining)
    // and has no sales/draws, and the product definition carries real stock.
    // Intentional sold-out states keep a positive totalInventory, so they are
    // never overwritten here.
    if (expectedSeed > 0 && storedTotal === 0 && storedRemaining === 0 && noActivity) {
      const healed: LiveStateRecord = {
        ...existing,
        sourceProductId: existing.sourceProductId || String(product.id || ''),
        productName: existing.productName || product.name,
        slug: existing.slug || product.slug,
        size,
        isActive: true,
        totalInventory: expectedSeed,
        inventoryRemaining: expectedSeed,
        winnersPerDraw: normalizeWinners(existing.winnersPerDraw, winnersPerDraw),
      };
      await redis.hset(LIVE_STATE_KEY, { [field]: JSON.stringify(healed) });
      return healed;
    }

    return {
      ...existing,
      sourceProductId: existing.sourceProductId || String(product.id || ''),
      productName: existing.productName || product.name,
      slug: existing.slug || product.slug,
      size,
      winnersPerDraw: normalizeWinners(existing.winnersPerDraw, winnersPerDraw),
    };
  }
  // Live inventory mirrors the product's real stock. FCFS products keep
  // maxRaffleAllocationLimit at 0 (no raffle cap), so fall back to
  // totalInventory whenever the raffle limit is unset or zero.
  const raffleLimit = Math.max(0, Number(product.maxRaffleAllocationLimit) || 0);
  const stock = Math.max(0, Number(product.totalInventory) || 0);
  const seedInventory = raffleLimit > 0 ? raffleLimit : stock;
  const seed: LiveStateRecord = {
    productId: field,
    sourceProductId: String(product.id || ''),
    productName: product.name,
    slug: product.slug,
    size,
    isActive: true,
    totalInventory: seedInventory,
    inventoryRemaining: seedInventory,
    winnersPerDraw: normalizeWinners(winnersPerDraw, 1),
    drawsCompleted: 0,
    salesCompleted: 0,
  };
  await redis.hset(LIVE_STATE_KEY, { [field]: JSON.stringify(seed) });
  return seed;
}

export async function saveLiveState(redis: Redis, state: LiveStateRecord) {
  const normalized: LiveStateRecord = {
    ...state,
    sourceProductId: String(state.sourceProductId || resolveLiveStateSourceProductId(state) || ''),
    winnersPerDraw: normalizeWinners(state.winnersPerDraw, 1),
    inventoryRemaining: Math.max(0, Number(state.inventoryRemaining) || 0),
    totalInventory: Math.max(0, Number(state.totalInventory) || 0),
    salesCompleted: Math.max(0, Number(state.salesCompleted) || 0),
    drawsCompleted: Math.max(0, Number(state.drawsCompleted) || 0),
  };
  await redis.hset(LIVE_STATE_KEY, { [normalized.productId]: JSON.stringify(normalized) });
}

export async function listLiveStates(redis: Redis): Promise<LiveStateRecord[]> {
  try {
    const hash = (await redis.hgetall(LIVE_STATE_KEY)) as Record<string, string> | null;
    if (!hash) return [];
    return Object.values(hash).map((r) => safeParseRedisItem<LiveStateRecord>(r)).filter(Boolean) as LiveStateRecord[];
  } catch {
    return [];
  }
}

export async function getLiveProductState(redis: Redis, productOrId: any, size: string, fourth?: any): Promise<LiveStateRecord> {
  let id = '', name = '', slug = '', seedInv = 10, winners = 1, isActive = true;
  if (typeof productOrId === 'string') {
    id = productOrId; name = productOrId; slug = productOrId;
    const opts = fourth && typeof fourth === 'object' ? fourth : {};
    seedInv = Number(opts.totalInventory ?? opts.inventoryRemaining ?? 10) || 10;
    winners = normalizeWinners(opts.winnersPerDraw, 1);
    isActive = opts.isActive !== false;
    if (opts.productName) name = String(opts.productName);
    if (opts.slug) slug = String(opts.slug);
  } else if (productOrId && typeof productOrId === 'object') {
    id = String(productOrId.id || ''); name = String(productOrId.name || productOrId.id || ''); slug = String(productOrId.slug || productOrId.id || '');
    // Prefer the raffle cap when set; otherwise seed from real stock so FCFS
    // products (maxRaffleAllocationLimit = 0) never collapse to the 10-unit default.
    const raffleLimit = Math.max(0, Number(productOrId.maxRaffleAllocationLimit) || 0);
    const stock = Math.max(0, Number(productOrId.totalInventory) || 0);
    seedInv = (raffleLimit > 0 ? raffleLimit : stock) || 10;
    if (typeof fourth === 'number') winners = normalizeWinners(fourth, 1);
    else if (fourth && typeof fourth === 'object') {
      winners = normalizeWinners(fourth.winnersPerDraw, 1);
      seedInv = Number(fourth.totalInventory ?? seedInv) || seedInv;
      isActive = fourth.isActive !== false;
      if (fourth.productName) name = String(fourth.productName);
      if (fourth.slug) slug = String(fourth.slug);
    }
  }
  const state = await getOrSeedLiveState(redis, { id, name, slug, maxRaffleAllocationLimit: seedInv }, size, winners);
  if (!isActive) { state.isActive = false; await saveLiveState(redis, state); }
  return state;
}

export async function setLiveProductState(redis: Redis, state: any) {
  const normalized: LiveStateRecord = {
    productId: String(state.productId || ''),
    sourceProductId: String(state.sourceProductId || state.id || ''),
    productName: String(state.productName || state.name || ''),
    slug: String(state.slug || ''),
    size: String(state.size || 'Standard'),
    isActive: state.isActive !== false,
    totalInventory: Math.max(0, Number(state.totalInventory) || 0),
    inventoryRemaining: Math.max(0, Number(state.inventoryRemaining) || 0),
    winnersPerDraw: normalizeWinners(state.winnersPerDraw, 1),
    drawsCompleted: Math.max(0, Number(state.drawsCompleted) || 0),
    salesCompleted: Math.max(0, Number(state.salesCompleted) || 0),
  };
  await saveLiveState(redis, normalized);
}

export function getWinnerCountForDraw(sizeOrConfig?: any, configWinners50 = 1, configWinners100 = 1): number {
  if (typeof sizeOrConfig === 'string') return sizeOrConfig === '100ml' ? configWinners100 : configWinners50;
  if (sizeOrConfig && typeof sizeOrConfig === 'object') return normalizeWinners(sizeOrConfig.winnersPer50ml ?? sizeOrConfig.winnersPerDraw, 1);
  return 1;
}

export async function resetPoolAndBlocks(redis: Redis, productName: string, size: string) {
  const poolKey = `drop_pool:${productName}:${size}`;
  const intentKey = `intent_pool:${productName}:${size}`;
  await Promise.all([
    redis.del(poolKey), redis.del(intentKey),
    redis.del(emailBlockKey(productName, size)), redis.del(cardBlockKey(productName, size)),
    redis.hset(POOL_STATS_KEY, {
      [poolStatField('sub', productName, size)]: '0',
      [poolStatField('int', productName, size)]: '0',
    }),
  ]);
}

export async function cleanupMatchingIntent(redis: Redis, variant: string, size: string, email: string) {
  const intentKey = `intent_pool:${variant}:${size}`;
  let removedCount = 0;
  try {
    const intentItems = await redis.lrange(intentKey, 0, -1);
    for (const item of intentItems) {
      const parsed = safeParseRedisItem<any>(item);
      if (parsed && String(parsed.email || '').toLowerCase() === email.toLowerCase()) {
        await redis.lrem(intentKey, 1, item);
        removedCount++;
      }
    }
    if (removedCount > 0) await redis.hincrby(POOL_STATS_KEY, poolStatField('int', variant, size), -removedCount);
  } catch {}
  return removedCount;
}

export interface FoundPoolEntry {
  poolKey: string; variant: string; size: string; index: number; parsed: any;
}

async function listPoolKeysForProduct(redis: Redis, prefix: 'drop_pool' | 'intent_pool', productName: string): Promise<string[]> {
  try {
    const keys = await redis.keys(`${prefix}:${productName}:*`);
    return Array.isArray(keys) ? keys : [];
  } catch {
    return [];
  }
}

export async function findPoolEntriesByEmail(redis: Redis, productNames: string[], email: string): Promise<FoundPoolEntry[]> {
  const normalizedEmail = email.trim().toLowerCase();
  const matches: FoundPoolEntry[] = [];
  for (const productName of productNames) {
    const poolKeys = await listPoolKeysForProduct(redis, 'drop_pool', productName);
    for (const poolKey of poolKeys) {
      const size = String(poolKey.split(':').slice(2).join(':') || 'Standard');
      const items = await redis.lrange(poolKey, 0, -1);
      items.forEach((raw, index) => {
        const parsed = safeParseRedisItem<any>(raw);
        if (parsed && String(parsed.email || '').toLowerCase() === normalizedEmail) {
          matches.push({ poolKey, variant: productName, size, index, parsed });
        }
      });
    }
  }
  return matches;
}

// ============================================================
// ADMIN ORDER MANAGEMENT — every open entry across every pool,
// with the tools to cancel or edit any of them from /admin.
// This is different from findPoolEntriesByEmail: that's scoped
// to one customer verifying themselves; this is the admin's
// full, unscoped view of every live order.
// ============================================================
export async function findAllOpenOrders(redis: Redis, productNames: string[]): Promise<FoundPoolEntry[]> {
  const matches: FoundPoolEntry[] = [];
  for (const productName of productNames) {
    const poolKeys = await listPoolKeysForProduct(redis, 'drop_pool', productName);
    for (const poolKey of poolKeys) {
      const size = String(poolKey.split(':').slice(2).join(':') || 'Standard');
      const items = await redis.lrange(poolKey, 0, -1);
      items.forEach((raw, index) => {
        const parsed = safeParseRedisItem<any>(raw);
        if (parsed) matches.push({ poolKey, variant: productName, size, index, parsed });
      });
    }
  }
  // Newest first
  matches.sort((a, b) => {
    const ta = new Date(a.parsed.registeredAt || 0).getTime();
    const tb = new Date(b.parsed.registeredAt || 0).getTime();
    return tb - ta;
  });
  return matches;
}

export async function removeListEntryAtIndex(redis: Redis, key: string, index: number) {
  const tombstone = `__DELETED_ENTRY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  await redis.lset(key, index, tombstone);
  await redis.lrem(key, 1, tombstone);
}

// Admin-driven cancel of ANY order (no email/last4 verification needed —
// the admin password already gated this route). Frees the email/card slot
// so the person can re-enter if the admin is resolving a support issue.
export async function adminCancelOrder(redis: Redis, order: FoundPoolEntry, reason: string) {
  await removeListEntryAtIndex(redis, order.poolKey, order.index);
  await redis.hincrby(POOL_STATS_KEY, poolStatField('sub', order.variant, order.size), -1);
  const email = String(order.parsed.email || '').toLowerCase();
  if (email) await redis.srem(emailBlockKey(order.variant, order.size), email);
  if (order.parsed.cardFingerprint) await redis.srem(cardBlockKey(order.variant, order.size), order.parsed.cardFingerprint);
  await archiveEntry(redis, {
    email,
    variant: order.variant,
    size: order.size,
    shippingAddress: order.parsed.shippingAddress || order.parsed.address || 'Unknown',
    id: order.parsed.customerId || order.parsed.stripeCustomerId || 'n/a',
    registeredAt: new Date().toISOString(),
    type: 'CANCELLED_BY_ADMIN',
    shippingStatus: undefined,
    promoCode: order.parsed.promoCode || undefined,
  } as any);
  // Log the human-readable reason separately so it shows in the ledger note.
  if (reason) {
    await archiveEntry(redis, {
      email,
      variant: order.variant,
      size: order.size,
      shippingAddress: `Admin note: ${reason}`,
      id: order.parsed.customerId || 'n/a',
      registeredAt: new Date().toISOString(),
      type: 'ADMIN_NOTE',
    });
  }
}

export async function adminUpdateOrderAddress(redis: Redis, order: FoundPoolEntry, newAddress: string) {
  const updated = { ...order.parsed, shippingAddress: newAddress, address: newAddress };
  await redis.lset(order.poolKey, order.index, JSON.stringify(updated));
  await archiveEntry(redis, {
    email: String(order.parsed.email || '').toLowerCase(),
    variant: order.variant,
    size: order.size,
    shippingAddress: newAddress,
    id: order.parsed.customerId || 'n/a',
    registeredAt: new Date().toISOString(),
    type: 'ADDRESS_UPDATED',
  });
}

export interface CatalogArchiveRecord {
  productId: string; name: string; image?: string; description?: string;
  availableFrom: string; archivedAt: string; notes?: string; soldOut?: boolean;
}

export async function archiveProductToCatalog(redis: Redis, record: CatalogArchiveRecord) {
  await redis.hset(CATALOG_ARCHIVE_KEY, { [record.productId]: JSON.stringify(record) });
}
export async function unarchiveProductFromCatalog(redis: Redis, productId: string) {
  await redis.hdel(CATALOG_ARCHIVE_KEY, productId);
}
export async function getCatalogArchiveRecords(redis: Redis): Promise<CatalogArchiveRecord[]> {
  try {
    const hash = (await redis.hgetall(CATALOG_ARCHIVE_KEY)) as Record<string, string> | null;
    if (!hash) return [];
    return Object.values(hash).map((raw) => safeParseRedisItem<CatalogArchiveRecord>(raw)).filter(Boolean) as CatalogArchiveRecord[];
  } catch {
    return [];
  }
}

export async function getOnlineVisitors(redis: Redis, trafficKey: string, limit = 50) {
  try {
    const raw = (await redis.zrange(trafficKey, -limit, -1, { withScores: true })) as (string | number)[];
    const now = Date.now();
    const visitors: { visitorId: string; lastSeenSecondsAgo: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      visitors.push({ visitorId: String(raw[i]), lastSeenSecondsAgo: Math.max(0, Math.round((now - Number(raw[i + 1])) / 1000)) });
    }
    visitors.sort((a, b) => a.lastSeenSecondsAgo - b.lastSeenSecondsAgo);
    return visitors;
  } catch {
    return [];
  }
}

export function createRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.REDIS_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

/**
 * Resolve the admin password used to gate /admin and the admin API routes.
 *
 * In production the value MUST come from `ADMIN_BASIC_AUTH_PASSWORD` (set in
 * the platform's environment). Outside production we allow a documented local
 * dev fallback so the admin portal stays usable on a fresh clone without env
 * setup — it is never active in production builds.
 */
export function getAdminPassword(): string {
  const configured = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (configured) return configured;
  if (process.env.NODE_ENV !== 'production') return 'goyunir-admin-dev';
  return '';
}

export function createStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  try {
    // Let the installed Stripe SDK pick its supported latest API version.
    return new Stripe(secretKey);
  } catch {
    return null;
  }
}

// ============================================================
// STRIPE PRICE ID DEFAULTS
// ============================================================
// There is intentionally NO hardcoded Stripe price ID in this codebase — a
// published template must never charge against a price ID owned by the
// template author. Resolution order:
//  1. The price ID explicitly set per product/size in /admin (stored in
//     Redis) always wins.
//  2. Otherwise the STRIPE_PRODUCT_ID env var is used (set in Vercel).
//  3. Otherwise an obviously-placeholder ID is returned so checkout fails with
//     a clear "set it in admin" error instead of silently charging something.
export const UNCONFIGURED_STRIPE_PRICE_ID = 'price_placeholder_not_configured';

export function defaultStripePriceId(): string {
  return (process.env.STRIPE_PRODUCT_ID || '').trim() || UNCONFIGURED_STRIPE_PRICE_ID;
}

/**
 * Resolves the Stripe price ID that should be used to charge a category.
 * Empty / placeholder values fall back to the env default. An ID explicitly
 * set per product/size in the admin portal always wins.
 */
export function resolveStripePriceId(stored?: string | null): string {
  const raw = typeof stored === 'string' ? stored.trim() : '';
  if (!raw || raw.startsWith('price_placeholder')) return defaultStripePriceId();
  return raw;
}

export function buildAbsoluteUrl(request: Request | undefined, path = '/') {
  const host = request?.headers.get('x-forwarded-host') ?? request?.headers.get('host') ?? 'localhost:3000';
  const protocol = request?.headers.get('x-forwarded-proto') ?? (process.env.VERCEL_ENV === 'production' ? 'https' : 'http');
  return new URL(path, `${protocol}://${host}`).toString();
}

// ============================================================
// LIVE CONFIG OVERRIDES — lets /admin change schedule, social
// proof, and pricing without a redeploy.
// ============================================================
export const CONFIG_DROP_SCHEDULE_KEY = 'config:drop_schedule';
export const CONFIG_SOCIAL_PROOF_KEY = 'config:social_proof';
export const CONFIG_PRODUCT_OVERRIDE_PREFIX = 'config:product:';

export async function getGlobalScheduleOverride(redis: Redis): Promise<Record<string, any> | null> {
  return safeParseRedisItem<any>(await redis.get(CONFIG_DROP_SCHEDULE_KEY));
}
export async function saveGlobalScheduleOverride(redis: Redis, value: Record<string, any>) {
  await redis.set(CONFIG_DROP_SCHEDULE_KEY, JSON.stringify(value));
}

export async function getSocialProofOverride(redis: Redis): Promise<Record<string, any> | null> {
  return safeParseRedisItem<any>(await redis.get(CONFIG_SOCIAL_PROOF_KEY));
}
export async function saveSocialProofOverride(redis: Redis, value: Record<string, any>) {
  await redis.set(CONFIG_SOCIAL_PROOF_KEY, JSON.stringify(value));
}

export interface ProductOverride {
  customDropSchedule?: Record<string, any>;
  price50ml?: number;
  price100ml?: number;
}
export async function getProductOverride(redis: Redis, productId: string): Promise<ProductOverride | null> {
  return safeParseRedisItem<ProductOverride>(await redis.get(CONFIG_PRODUCT_OVERRIDE_PREFIX + productId));
}
export async function saveProductOverride(redis: Redis, productId: string, value: ProductOverride) {
  await redis.set(CONFIG_PRODUCT_OVERRIDE_PREFIX + productId, JSON.stringify(value));
}
export async function getAllProductOverrides(redis: Redis, productIds: string[]): Promise<Record<string, ProductOverride>> {
  const out: Record<string, ProductOverride> = {};
  for (const id of productIds) {
    const o = await getProductOverride(redis, id);
    if (o) out[id] = o;
  }
  return out;
}

export async function trackPromoClick(redis: Redis, code: string) {
  const raw = await redis.hget(PROMOS_KEY, code);
  const promo = safeParseRedisItem<any>(raw);
  if (!promo) return false;
  promo.clicks = (promo.clicks || 0) + 1;
  await redis.hset(PROMOS_KEY, { [code]: JSON.stringify(promo) });
  return true;
}

function normalizePriceCategory(category: any, fallbackSize: string) {
  const size = typeof category?.size === 'string' && category.size.trim() ? category.size.trim() : fallbackSize;
  const price = typeof category?.price === 'number' ? category.price : Number(category?.price ?? 0);
  const rawStripeId = typeof category?.stripeId === 'string' && category.stripeId.trim()
    ? category.stripeId
    : (typeof category?.stripePriceId === 'string' && category.stripePriceId.trim() ? category.stripePriceId : '');
  const stripeId = resolveStripePriceId(rawStripeId);
  const winnerTiers = typeof category?.winnerTiers === 'string'
    ? category.winnerTiers
    : (Array.isArray(category?.winnerTiers) ? category.winnerTiers.join(',') : '0');
  return {
    size,
    price: Number.isFinite(price) ? price : 0,
    stripeId,
    winnerTiers,
  };
}

function normalizeFallbackProduct(product: any, index: number) {
  const fallbackSize = Array.isArray(GOYUNIR_STORE_SUITE.availableSizes) && GOYUNIR_STORE_SUITE.availableSizes.length
    ? String(GOYUNIR_STORE_SUITE.availableSizes[0])
    : 'Standard';

  const fallbackCategories = Array.isArray(product?.priceCategories) && product.priceCategories.length > 0
    ? product.priceCategories.map((category: any) => normalizePriceCategory(category, fallbackSize))
    : [{ size: fallbackSize, price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId(), winnerTiers: '0' }];

  return {
    ...product,
    id: String(product?.id || `fallback-${index + 1}`),
    name: String(product?.name || `Product ${index + 1}`),
    slug: String(product?.slug || `product-${index + 1}`),
    prefix: String(product?.prefix || `product-${index + 1}`),
    tagline: String(product?.tagline || 'LIMITED DROP'),
    desc: String(product?.desc || ''),
    priceCategories: fallbackCategories,
    images: Array.isArray(product?.images) ? product.images : [],
    isActive: product?.isActive !== false,
    isArchived: Boolean(product?.isArchived),
    isUpcoming: Boolean(product?.isUpcoming),
    isRaffle: product?.isRaffle !== false,
    checkoutMode: String(product?.checkoutMode || (product?.isRaffle === false ? 'FCFS' : 'RAFFLE')),
    productType: String(product?.productType || (product?.isRaffle === false ? 'checkout' : 'raffle')),
    totalInventory: Number(product?.totalInventory ?? 0) || 0,
    winnerTiers: Array.isArray(product?.winnerTiers) ? product.winnerTiers : (typeof product?.winnerTiers === 'number' ? [product.winnerTiers] : [0]),
  };
}

export function getFallbackStoreProducts(): Record<string, any> {
  const sourceProducts = Array.isArray((GOYUNIR_STORE_SUITE as any).productCatalog) ? (GOYUNIR_STORE_SUITE as any).productCatalog : [];
  return sourceProducts.reduce((out: Record<string, any>, product: any, index: number) => {
    const key = String(product?.id || `fallback-${index + 1}`);
    out[key] = normalizeFallbackProduct(product, index);
    return out;
  }, {});
}

export async function loadProducts(redis: any): Promise<Record<string, any>> {
  // Return an empty map when Redis is missing or has no products yet — the
  // storefront should show zero items until a seed is generated in Redis via
  // the admin portal (Seed Defaults / Add Product). No config fallback catalog
  // is served on the public site.
  if (!redis) return {};

  try {
    const raw = await redis.hgetall('store:products');
    if (!raw || Object.keys(raw).length === 0) return {};

    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(raw)) {
      const parsed = safeParseRedisItem<any>(v);
      if (parsed) {
        const normalized = {
          ...parsed,
          priceCategories: Array.isArray(parsed.priceCategories) && parsed.priceCategories.length > 0
            ? parsed.priceCategories.map((category: any) => normalizePriceCategory(category, 'Standard'))
            : [{ size: 'Standard', price: UNCONFIGURED_PRICE_SENTINEL, stripeId: defaultStripePriceId(), winnerTiers: '0' }],
        };
        out[k] = normalized;
      }
    }

    return out;
  } catch {
    return {};
  }
}