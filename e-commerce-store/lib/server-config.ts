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

// Upstash's Redis client auto-deserializes JSON strings into objects on read.
// Calling JSON.parse() again on an already-parsed object turns it into the
// literal string "[object Object]" before parsing fails.
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

// Pool entries have been written by three different code paths over time,
// and not all of them used the same field name for the Stripe customer ID.
// This is the single fix that makes charges actually execute reliably:
// always check BOTH possible field names, no matter which path wrote the entry.
export function resolveCustomerId(entry: any): string {
  return String(entry?.customerId || entry?.stripeCustomerId || '');
}

// ============================================
// PERMANENT ARCHIVE — nothing is ever deleted. Every entry, win, loss,
// cancellation, started-but-abandoned checkout, and duplicate attempt gets
// logged here forever, so the admin search bar can always answer
// "what happened with X."
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
  // 'INTENT_STARTED' | 'ENTERED' | 'DUPLICATE_BLOCKED' | 'WINNER_CHARGED' |
  // 'WINNER_DECLINED' | 'NOT_SELECTED' | 'INTENT_EXPIRED' | 'CANCELLED_BY_USER'
}

export async function archiveEntry(redis: Redis, record: ArchiveRecord) {
  try {
    await redis.rpush(ARCHIVE_LEDGER_KEY, JSON.stringify(record));
  } catch {}
}

// ============================================
// LIVE POOL STATS — a single Redis Hash instead of dozens of LLEN/LRANGE calls.
// ============================================
export const POOL_STATS_KEY = 'stats:pools';

export function poolStatField(kind: 'sub' | 'int', variant: string, size: string) {
  return `${kind}:${variant}:${size}`;
}

export const SOCIAL_PROOF_BOOST_KEY = 'stats:social_proof_boost';

// ============================================
// FRAUD PREVENTION — one entry per EMAIL, one entry per CARD (not address —
// families/roommates legitimately share addresses; this is the SNKRS pattern).
// ============================================
export function emailBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:emails`;
}
export function cardBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:cards`;
}

export const PROCESSED_SESSIONS_KEY = 'drop_processed_sessions';
export const LAST_DRAW_KEY = 'drop_last_draw_summary';

// Removes any "in-progress checkout" intent(s) matching this email once that
// checkout has actually resolved (success OR duplicate-blocked), so it never
// lingers to be double-logged as an abandoned cart at draw time.
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

// Resets a product/size's LIVE pool, intent list, stats, AND duplicate-block
// sets — this is what makes re-entry possible for the next drop window.
// Nothing here touches the permanent archive.
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
// ACCOUNT-FREE ENTRY MANAGEMENT — email + last-4-of-card verification.
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
// CATALOG ARCHIVE — lets an admin move a finished product's run into the
// public Catalog page's archive section, with the dates it was available.
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

// ============================================
// ONLINE VISITORS — lets the admin see who (anonymized session IDs, no PII)
// is currently on the site, not just a count.
// ============================================
export async function getOnlineVisitors(redis: Redis, trafficKey: string) {
  try {
    const raw = (await redis.zrange(trafficKey, 0, -1, { withScores: true })) as (string | number)[];
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