/**
 * SERVICES / PAYMENT â€” the PaymentDriver contract.
 *
 * Functional features resolve the active provider through
 * `PaymentFactory.getDriver()` and call the standardized
 * `createCheckoutSession(price, siteId, options)` â€” the provider SDKs/REST
 * calls live inside the concrete drivers only.
 *
 * NOTE ON SCOPE: the storefront's RAFFLE flow uses Stripe `mode: 'setup'` (card
 * saved, charged only if drawn) â€” a Stripe-only concept. Lemon Squeezy / Paddle
 * drivers power the INSTANT-BUY (FCFS) path through their hosted checkouts; the
 * checkout route rejects raffle card-save cleanly for non-Stripe providers.
 *
 * This file has zero `@/` imports on purpose so the node --test runner can load
 * it directly.
 */

import type { PaymentProvider } from '../config/types.ts';

/** Everything a hosted checkout needs. `successUrl` may contain the
 *  `{CHECKOUT_SESSION_ID}` placeholder â€” drivers substitute their own id. */
export interface CheckoutSessionOptions {
  /** Total amount in the smallest currency unit (cents). */
  priceCents: number;
  /** Tenant/site identifier (per spec) â€” passed to providers as custom data. */
  siteId: string;
  currency?: string;
  successUrl: string;
  cancelUrl?: string;
  customerEmail?: string;
  productName: string;
  productDescription?: string;
  metadata?: Record<string, string>;
  /** Extra email that receives the payment receipt (Stripe). */
  receiptEmail?: string;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
  provider: PaymentProvider;
}

export interface PaymentDriver {
  readonly provider: PaymentProvider;
  /** Whether the driver has the secrets it needs. */
  readonly configured: boolean;
  /**
   * Create a hosted checkout session. The spec'd 2-arg form works when the
   * caller only has a price + siteId; real flows pass `options` too.
   */
  createCheckoutSession(
    price: number,
    siteId: string,
    options?: Partial<CheckoutSessionOptions>,
  ): Promise<CheckoutSessionResult>;
}

/** Substitute the `{CHECKOUT_SESSION_ID}` placeholder in a return URL. */
export function replaceSessionPlaceholder(url: string, sessionId: string): string {
  return String(url || '').replace(/\{CHECKOUT_SESSION_ID\}/g, sessionId);
}
