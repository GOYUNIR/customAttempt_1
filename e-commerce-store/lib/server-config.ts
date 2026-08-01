import { Redis } from '@upstash/redis';
import Stripe from 'stripe';

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
}

export async function archiveEntry(redis: Redis, record: ArchiveRecord) {
  try {
    await redis.rpush(ARCHIVE_LEDGER_KEY, JSON.stringify(record));
  } catch {}
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

function normalizeWinners(value: unknown, fallback = 1): number {
  if (Array.isArray(value)) return Math.max(1, Number(value[0] ?? fallback) || fallback);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, value);
  if (typeof value === 'string' && value.trim()) return Math.max(1, Number(value) || fallback);
  return fallback;
}

export async function getOrSeedLiveState(
  redis: Redis,
  product: { id: string; name: string; slug: string; maxRaffleAllocationLimit: number },
  size: string,
  winnersPerDraw: number,
): Promise<LiveStateRecord> {
  const field = liveStateField(product.id, product.slug, size);
  const raw = await redis.hget(LIVE_STATE_KEY, field);
  const existing = safeParseRedisItem<LiveStateRecord>(raw);
  if (existing && typeof existing.inventoryRemaining === 'number') {
    return {
      ...existing,
      productName: existing.productName || product.name,
      slug: existing.slug || product.slug,
      size,
      winnersPerDraw: normalizeWinners(existing.winnersPerDraw, winnersPerDraw),
    };
  }
  const seed: LiveStateRecord = {
    productId: field,
    productName: product.name,
    slug: product.slug,
    size,
    isActive: true,
    totalInventory: Math.max(0, product.maxRaffleAllocationLimit),
    inventoryRemaining: Math.max(0, product.maxRaffleAllocationLimit),
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
    seedInv = Number(productOrId.maxRaffleAllocationLimit ?? productOrId.totalInventory ?? 10) || 10;
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
    productName: String(state.productName || state.name || ''),
    slug: String(state.slug || ''),
    size: String(state.size || '50ml'),
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

export async function findPoolEntriesByEmail(redis: Redis, productNames: string[], email: string): Promise<FoundPoolEntry[]> {
  const normalizedEmail = email.trim().toLowerCase();
  const matches: FoundPoolEntry[] = [];
  for (const productName of productNames) {
    for (const size of ['50ml', '100ml']) {
      const poolKey = `drop_pool:${productName}:${size}`;
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

export async function removeListEntryAtIndex(redis: Redis, key: string, index: number) {
  const tombstone = `__DELETED_ENTRY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  await redis.lset(key, index, tombstone);
  await redis.lrem(key, 1, tombstone);
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

export function createStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  try {
    return new Stripe(secretKey, { apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion });
  } catch {
    return null;
  }
}

export function buildAbsoluteUrl(request: Request | undefined, path = '/') {
  const host = request?.headers.get('x-forwarded-host') ?? request?.headers.get('host') ?? 'localhost:3000';
  const protocol = request?.headers.get('x-forwarded-proto') ?? (process.env.VERCEL_ENV === 'production' ? 'https' : 'http');
  return new URL(path, `${protocol}://${host}`).toString();
}

// ============================================================
// LIVE CONFIG OVERRIDES — lets /admin change schedule, social
// proof, and pricing without a redeploy. Storefront and
// trigger-drop read these on top of the goyunir.config.ts base.
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

// Promo click tracking (separate from `uses`, which only counts actual entries)
export async function trackPromoClick(redis: Redis, code: string) {
  const raw = await redis.hget(PROMOS_KEY, code);
  const promo = safeParseRedisItem<any>(raw);
  if (!promo) return false;
  promo.clicks = (promo.clicks || 0) + 1;
  await redis.hset(PROMOS_KEY, { [code]: JSON.stringify(promo) });
  return true;
}