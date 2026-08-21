/**
 * SERVICES / PAYMENT â€” Stripe driver.
 *
 * Uses the official `stripe` SDK (the codebase already ships it) â€” the SDK is
 * allowed INSIDE a driver; functional features only ever see the interface.
 * Stripe is also the ONLY provider able to run the storefront's raffle
 * card-save (setup) flow, so the driver additionally exposes
 * `getStripeClient()` / `getWebhookSecret()` for those Stripe-specific paths.
 */

import Stripe from 'stripe';
import type { PaymentDriver, CheckoutSessionOptions, CheckoutSessionResult } from './types.ts';
import type { PaymentProvider } from '../config/types.ts';

export interface StripeDriverOptions {
  apiKey: string;
  webhookSecret?: string;
}

export class StripeDriver implements PaymentDriver {
  readonly provider: PaymentProvider = 'stripe';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private stripeClient: Stripe | null = null;

  constructor(options: StripeDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.webhookSecret = String(options.webhookSecret || '').trim();
    if (this.configured) {
      try {
        this.stripeClient = new Stripe(this.apiKey);
      } catch {
        this.stripeClient = null;
      }
    }
  }

  /** Raw Stripe client â€” used ONLY by Stripe-specific flows (setup sessions,
   *  customers, webhook signature verification). */
  getStripeClient(): Stripe | null {
    return this.stripeClient;
  }

  /** Webhook signing secret for /api/stripe/webhook (from the wizard or env). */
  getWebhookSecret(): string {
    return this.webhookSecret;
  }

  async createCheckoutSession(
    price: number,
    siteId: string,
    options: Partial<CheckoutSessionOptions> = {},
  ): Promise<CheckoutSessionResult> {
    if (!this.stripeClient) {
      throw new Error('Stripe is not configured (payment_api_key missing).');
    }
    const priceCents = Math.max(1, Math.round(Number(price) || 0));
    const currency = (options.currency || 'usd').toLowerCase();
    const session = await this.stripeClient.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: options.customerEmail,
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: priceCents,
            product_data: {
              name: options.productName || `Order ${siteId}`,
              description: options.productDescription,
            },
          },
          quantity: 1,
        },
      ],
      // Stripe substitutes `{CHECKOUT_SESSION_ID}` server-side â€” pass raw.
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      metadata: {
        siteId,
        ...(options.metadata || {}),
      },
      payment_intent_data:
        options.receiptEmail || options.customerEmail
          ? {
              receipt_email: options.receiptEmail || options.customerEmail,
              metadata: { siteId, ...(options.metadata || {}) },
            }
          : undefined,
    });
    return {
      url: session.url || '',
      sessionId: session.id,
      provider: this.provider,
    };
  }
}
