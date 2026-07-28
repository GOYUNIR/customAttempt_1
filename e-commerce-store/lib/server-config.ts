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
  if (typeof globalThis === 'undefined') {
    return [];
  }

  if (!globalThis.__goyunirFallbackEntries) {
    globalThis.__goyunirFallbackEntries = [];
  }

  return globalThis.__goyunirFallbackEntries;
}

export function addFallbackEntry(entry: Omit<CheckoutRegistrationPayload, 'source'>): CheckoutRegistrationPayload[] {
  const store = getFallbackStore();
  const payload: CheckoutRegistrationPayload = {
    ...entry,
    source: 'fallback',
  };

  store.push(payload);
  return store;
}

export function getFallbackEntries(): CheckoutRegistrationPayload[] {
  return getFallbackStore();
}

export function createRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.REDIS_TOKEN;

  if (!url || !token) {
    return null;
  }

  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

export function createStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return null;
  }

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
