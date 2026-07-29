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
// literal string "[object Object]" before parsing fails. This helper handles
// both a raw string AND an already-parsed object safely.
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

// ============================================
// PERMANENT ARCHIVE — nothing is ever deleted from here.
// Every entry, win, loss, cancellation, and expired intent gets logged here
// forever, so the admin search bar can always answer "what happened with X."
// ============================================
export const ARCHIVE_LEDGER_KEY = 'archive:ledger';

export interface ArchiveRecord {
  email: string;
  variant: string;
  size: string;
  shippingAddress: string;
  id: string;
  registeredAt: string;
  type: string; // 'ENTERED' | 'WINNER_CHARGED' | 'WINNER_DECLINED' | 'NOT_SELECTED' | 'INTENT_EXPIRED' | 'CANCELLED_BY_USER'
}

export async function archiveEntry(redis: Redis, record: ArchiveRecord) {
  try {
    await redis.rpush(ARCHIVE_LEDGER_KEY, JSON.stringify(record));
  } catch {}
}

// ============================================
// LIVE POOL STATS — a single Redis Hash instead of dozens of LLEN/LRANGE
// calls. Biggest lever for cutting command usage.
// ============================================
export const POOL_STATS_KEY = 'stats:pools';

export function poolStatField(kind: 'sub' | 'int', variant: string, size: string) {
  return `${kind}:${variant}:${size}`;
}

// Randomized social-proof "boost" counter — resets after every draw.
export const SOCIAL_PROOF_BOOST_KEY = 'stats:social_proof_boost';

// ============================================
// FRAUD PREVENTION — one entry per EMAIL, one entry per CARD.
// Deliberately NOT address-based: roommates/family legitimately share
// addresses. This is how SNKRS/adidas CONFIRMED handle it.
// ============================================
export function emailBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:emails`;
}
export function cardBlockKey(variant: string, size: string) {
  return `drop_fraud_block:${variant}:${size}:cards`;
}

// Idempotency guard: confirm-setup (client redirect) AND the Stripe webhook
// can both try to process the same completed session. Ensures only one wins.
export const PROCESSED_SESSIONS_KEY = 'drop_processed_sessions';

// Persisted last-draw summary — NOT a JS global, since Vercel serverless
// functions don't share memory between invocations.
export const LAST_DRAW_KEY = 'drop_last_draw_summary';

// ============================================
// ACCOUNT-FREE ENTRY MANAGEMENT
// Finds a person's active raffle entries by email, so they can view/cancel/
// edit them using email + last-4-of-card as verification (no password
// database needed — same pattern as "confirmation number + last name").
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

// Remove-by-index idiom for Redis lists: overwrite the slot with a unique
// tombstone value, then remove that tombstone. Safer than trying to re-match
// the original JSON string exactly (key ordering isn't guaranteed to survive
// a parse+restringify round trip).
export async function removeListEntryAtIndex(redis: Redis, key: string, index: number) {
  const tombstone = `__DELETED_ENTRY_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
  await redis.lset(key, index, tombstone);
  await redis.lrem(key, 1, tombstone);
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