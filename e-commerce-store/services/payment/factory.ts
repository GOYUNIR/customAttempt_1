/**
 * SERVICES / PAYMENT — runtime factory + Stripe-specific resolvers.
 *
 * `PaymentFactory.getDriver()` is the ONLY way functional features obtain a
 * payment provider. Resolution order:
 *
 *   1. `global_platform_settings.payment_provider` + `.payment_api_key`
 *      (+ `.payment_webhook_secret` for Stripe) — Setup Wizard, TTL-cached.
 *   2. Legacy env fallback so an un-wizarded store keeps working:
 *        STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET → StripeDriver
 *        LEMONSQUEEZY_API_KEY                       → LemonSqueezyDriver
 *        PADDLE_API_KEY                             → PaddleDriver
 *   3. null when nothing is configured.
 *
 * `resolveStripeClient()` / `resolvePaymentWebhookSecret()` are convenience
 * accessors for the Stripe-specific paths (setup-mode raffle sessions, webhook
 * signature verification, winner charging) — they resolve the SAME settings so
 * a wizard-configured Stripe key drives every stripe flow.
 */

import { getPlatformSettings } from '@/services/config/platform-settings';
import { createPaymentDriver } from './registry';
import { StripeDriver } from './stripe.driver';
import type { PaymentDriver } from './types';
import type Stripe from 'stripe';

export class PaymentFactory {
  /** Resolve the active payment driver (cached settings; null when none). */
  static async getDriver(opts?: { force?: boolean }): Promise<PaymentDriver | null> {
    // 1. Wizard-configured provider.
    const settings = await getPlatformSettings(opts);
    if (settings?.payment_provider && settings.payment_api_key) {
      return createPaymentDriver(settings.payment_provider, settings.payment_api_key, {
        webhookSecret: settings.payment_webhook_secret || undefined,
        storeId: process.env.LEMONSQUEEZY_STORE_ID,
        variantId: process.env.LEMONSQUEEZY_VARIANT_ID,
      });
    }

    // 2. Legacy env fallbacks.
    if (process.env.STRIPE_SECRET_KEY) {
      return createPaymentDriver('stripe', process.env.STRIPE_SECRET_KEY, {
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
      });
    }
    if (process.env.LEMONSQUEEZY_API_KEY) {
      return createPaymentDriver('lemon_squeezy', process.env.LEMONSQUEEZY_API_KEY, {
        storeId: process.env.LEMONSQUEEZY_STORE_ID,
        variantId: process.env.LEMONSQUEEZY_VARIANT_ID,
      });
    }
    if (process.env.PADDLE_API_KEY) {
      return createPaymentDriver('paddle', process.env.PADDLE_API_KEY);
    }

    return null;
  }
}

/** Stripe client for the Stripe-only flows (setup sessions, charging, stock). */
export async function resolveStripeClient(): Promise<Stripe | null> {
  const driver = await PaymentFactory.getDriver();
  if (driver?.provider === 'stripe' && driver instanceof StripeDriver) {
    return driver.getStripeClient();
  }
  return null;
}

/** Stripe webhook signing secret (wizard → env fallback). */
export async function resolvePaymentWebhookSecret(): Promise<string> {
  const driver = await PaymentFactory.getDriver();
  if (driver?.provider === 'stripe' && driver instanceof StripeDriver) {
    const secret = driver.getWebhookSecret();
    if (secret) return secret;
  }
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}
