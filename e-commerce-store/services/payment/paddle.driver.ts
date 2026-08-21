/**
 * SERVICES / PAYMENT â€” Paddle driver (Paddle Billing, REST fetch-based).
 *
 * API: POST https://api.paddle.com/transactions
 * Docs: https://developer.paddle.com/api-reference/transactions/create-transaction
 *
 * Paddle Billing has no standalone "checkout session" object â€” you create an
 * automatically-collected TRANSACTION with inline (custom) items and Paddle
 * returns `data.checkout.url`, the hosted checkout the customer is redirected
 * to. `fetchImpl` is injectable for tests.
 */

import type { PaymentDriver, CheckoutSessionOptions, CheckoutSessionResult } from './types.ts';
import { replaceSessionPlaceholder } from './types.ts';
import type { PaymentProvider } from '../config/types.ts';

const PADDLE_API_URL = 'https://api.paddle.com/transactions';
/** Paddle requires an explicit API version header. */
const PADDLE_API_VERSION = '2024-01-01';

export interface PaddleDriverOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class PaddleDriver implements PaymentDriver {
  readonly provider: PaymentProvider = 'paddle';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PaddleDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async createCheckoutSession(
    price: number,
    siteId: string,
    options: Partial<CheckoutSessionOptions> = {},
  ): Promise<CheckoutSessionResult> {
    if (!this.configured) throw new Error('Paddle API key is not configured.');
    const priceCents = Math.max(1, Math.round(Number(price) || 0));
    const currency = (options.currency || 'USD').toUpperCase();

    const res = await this.fetchImpl(PADDLE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Paddle-Version': PADDLE_API_VERSION,
      },
      body: JSON.stringify({
        collection_mode: 'automatic',
        currency_code: currency,
        customer: options.customerEmail ? { email: options.customerEmail } : undefined,
        custom_data: { site_id: siteId, ...(options.metadata || {}) },
        items: [
          {
            quantity: 1,
            price: {
              name: options.productName || `Order ${siteId}`,
              description: options.productDescription,
              type: 'custom',
              billing_cycle: null,
              trial_period: null,
              unit_price: { amount: String(priceCents), currency_code: currency },
            },
          },
        ],
        return_url: options.successUrl,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Paddle error ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { id?: string; checkout?: { url?: string } };
    } | null;
    const id = String(body?.data?.id || '');
    const url = String(body?.data?.checkout?.url || '');
    if (!id || !url) throw new Error('Paddle did not return a checkout url.');
    return {
      url: replaceSessionPlaceholder(url, id),
      sessionId: id,
      provider: this.provider,
    };
  }
}
