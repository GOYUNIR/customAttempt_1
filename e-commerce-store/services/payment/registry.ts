/**
 * SERVICES / PAYMENT â€” driver registry (pure factory helper).
 *
 * `createPaymentDriver()` maps a provider string to its concrete driver with
 * zero `@/` imports / DB / network access so the node --test runner can load
 * it directly. The runtime `PaymentFactory` (factory.ts) resolves the provider
 * + key from the platform settings and delegates here.
 */

import type { PaymentProvider } from '../config/types.ts';
import type { PaymentDriver } from './types.ts';
import { StripeDriver, type StripeDriverOptions } from './stripe.driver.ts';
import { LemonSqueezyDriver, type LemonSqueezyDriverOptions } from './lemon-squeezy.driver.ts';
import { PaddleDriver, type PaddleDriverOptions } from './paddle.driver.ts';

export interface PaymentDriverResolutionOptions {
  webhookSecret?: string;
  storeId?: string;
  variantId?: string;
  fetchImpl?: typeof fetch;
}

/** Resolve the provider string â†’ driver instance. Returns null for unknown. */
export function createPaymentDriver(
  provider: PaymentProvider,
  apiKey: string,
  options: PaymentDriverResolutionOptions = {},
): PaymentDriver | null {
  switch (provider) {
    case 'stripe':
      return new StripeDriver({
        apiKey,
        webhookSecret: options.webhookSecret,
      } as StripeDriverOptions);
    case 'lemon_squeezy':
      return new LemonSqueezyDriver({
        apiKey,
        storeId: options.storeId,
        variantId: options.variantId,
        fetchImpl: options.fetchImpl,
      } as LemonSqueezyDriverOptions);
    case 'paddle':
      return new PaddleDriver({ apiKey, fetchImpl: options.fetchImpl } as PaddleDriverOptions);
    default:
      return null;
  }
}

/** Every supported provider (used by the Setup Wizard dropdowns + tests). */
export const PAYMENT_DRIVER_CATALOG: ReadonlyArray<{ provider: PaymentProvider; label: string; hint: string }> = [
  { provider: 'stripe', label: 'Stripe', hint: 'raffle card-save + instant-buy, webhooks' },
  { provider: 'lemon_squeezy', label: 'Lemon Squeezy', hint: 'Merchant-of-record checkout (instant-buy only)' },
  { provider: 'paddle', label: 'Paddle', hint: 'Paddle Billing custom checkout (instant-buy only)' },
];
