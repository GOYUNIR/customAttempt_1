import { Redis } from '@upstash/redis';
import Stripe from 'stripe';

export interface CheckoutRegistrationPayload {
  email: string;
  variant: string;
  size: string;
  address: string;
  quantity: number;
  registeredAt: number;
  customerId?: string;
  paymentMethodId?: string;
  sessionId?: string;
  source: 'fallback' | 'redis';
}

declare global {
  var __goyunirFallbackEntries: CheckoutRegistrationPayload[] | undefined;
}

function getFallbackStore(): CheckoutRegistrationPayload[] {
  if (typeof globalThis === 'undefined') return [];
  if (!globalThis.__goyunirFallbackEntries) globalThis.__goyunirFallbackEntries = [];
  return globalThis.__goyunirFallbackEntries;
}

export function addFallbackEntry(entry: Omit<CheckoutRegistrationPayload, 'source'>): CheckoutRegistrationPayload[] {
  const store = getFallbackStore();
  store.push({ ...entry, source: 'fallback' });
  return store;
}

export function getFallbackEntries(): CheckoutRegistrationPayload[] {
  return getFallbackStore();
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

export function resolveCustomerId(entry: any): string {
  return String(entry?.customerId || entry?.stripeCustomerId || '');
}

// ============================================
// PERMANENT ARCHIVE — nothing is ever deleted.
// ============================================
export const ARCHIVE_LEDGER_KEY = 'archive:ledger';

export interface ArchiveRecord {
  email: string;
  variant: string;
  size: string;
  shippingAddress: string;
  id: string;
  registeredAt: string;
  type: string;
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

export function emailBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:emails`;
}
export function cardBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:cards`;
}

export const PROCESSED_SESSIONS_KEY = 'drop_processed_sessions';
export const LAST_DRAW_KEY = 'drop_last_draw_summary';

export async function cleanupMatchingIntent(redis: Redis, variant: string, size: string, email: string): Promise<number> {
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
    if (removedCount > 0) {
      await redis.hincrby(POOL_STATS_KEY, poolStatField('int', variant, size), -removedCount);
    }
  } catch {}
  return removedCount;
}

export async function resetPoolAndBlocks(redis: Redis, productName: string, size: string) {
  const poolKey = `drop_pool:${productName}:${size}`;
  const intentKey = `intent_pool:${productName}:${size}`;
  await Promise.all([
    redis.del(poolKey),
    redis.del(intentKey),
    redis.del(emailBlockKey(productName, size)),
    redis.del(cardBlockKey(productName, size)),
    redis.hset(POOL_STATS_KEY, {
      [poolStatField('sub', productName, size)]: '0',
      [poolStatField('int', productName, size)]: '0',
    }),
  ]);
}

// ============================================
// ACCOUNT-FREE ENTRY MANAGEMENT
// ============================================
export interface FoundPoolEntry {
  poolKey: string;
  variant: string;
  size: string;
  index: number;
  parsed: any;
}

export async function findPoolEntriesByEmail(
  redis: Redis,
  productNames: string[],
  email: string,
): Promise<FoundPoolEntry[]> {
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

// ============================================
// CATALOG ARCHIVE — admin can archive/unarchive at any time; products can
// also carry scheduled dates in goyunir.config.ts for automatic archiving.
// ============================================
export const CATALOG_ARCHIVE_KEY = 'catalog:archive_state';

export interface CatalogArchiveRecord {
  productId: string;
  name: string;
  image?: string;
  description?: string;
  availableFrom: string;
  archivedAt: string;
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
    return Object.values(hash)
      .map((raw) => safeParseRedisItem<CatalogArchiveRecord>(raw))
      .filter(Boolean) as CatalogArchiveRecord[];
  } catch {
    return [];
  }
}

export async function isProductArchived(redis: Redis, productId: string): Promise<boolean> {
  try {
    const val = await redis.hget(CATALOG_ARCHIVE_KEY, productId);
    return val != null;
  } catch {
    return false;
  }
}

// ============================================
// ONLINE VISITORS — capped for scale safety. Total count (ZCARD) is always
// accurate even when the detail list below is capped.
// ============================================
export async function getOnlineVisitors(redis: Redis, trafficKey: string, limit = 50) {
  try {
    // -limit,-1 = the most-recently-scored N members (scores are timestamps).
    const raw = (await redis.zrange(trafficKey, -limit, -1, { withScores: true })) as (string | number)[];
    const now = Date.now();
    const visitors: { visitorId: string; lastSeenSecondsAgo: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const visitorId = String(raw[i]);
      const score = Number(raw[i + 1]);
      visitors.push({ visitorId, lastSeenSecondsAgo: Math.max(0, Math.round((now - score) / 1000)) });
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
    return new Stripe(secretKey, {
      apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion,
    });
  } catch {
    return null;
  }
}

export function buildAbsoluteUrl(request: Request | undefined, path = '/') {
  const host = request?.headers.get('x-forwarded-host') ?? request?.headers.get('host') ?? 'localhost:3000';
  const protocol = request?.headers.get('x-forwarded-proto') ?? (process.env.VERCEL_ENV === 'production' ? 'https' : 'http');
  return new URL(path, `${protocol}://${host}`).toString();
}