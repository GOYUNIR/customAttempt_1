/**
 * SERVICES / PAYMENT â€” Lemon Squeezy driver (REST, fetch-based â€” no SDK).
 *
 * API: POST https://api.lemonsqueezy.com/v1/checkouts
 * Docs: https://docs.lemonsqueezy.com/api/checkouts
 *
 * A Lemon Squeezy checkout belongs to a Store and is associated with a
 * Variant. The wizard stores only the API key, so:
 *   - the `siteId` argument is treated as the STORE id when it is numeric,
 *     otherwise the operator must set `LEMONSQUEEZY_STORE_ID`;
 *   - `LEMONSQUEEZY_VARIANT_ID` selects the catalog variant (custom_price
 *     overrides its price at checkout time).
 * `fetchImpl` is injectable for tests.
 */

import type { PaymentDriver, CheckoutSessionOptions, CheckoutSessionResult } from './types.ts';
import { replaceSessionPlaceholder } from './types.ts';
import type { PaymentProvider } from '../config/types.ts';

const LEMONSQUEEZY_API_URL = 'https://api.lemonsqueezy.com/v1/checkouts';

export interface LemonSqueezyDriverOptions {
  apiKey: string;
  storeId?: string;
  variantId?: string;
  fetchImpl?: typeof fetch;
}

export class LemonSqueezyDriver implements PaymentDriver {
  readonly provider: PaymentProvider = 'lemon_squeezy';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly storeId: string;
  private readonly variantId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LemonSqueezyDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.storeId = String(options.storeId || '').trim();
    this.variantId = String(options.variantId || '').trim();
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async createCheckoutSession(
    price: number,
    siteId: string,
    options: Partial<CheckoutSessionOptions> = {},
  ): Promise<CheckoutSessionResult> {
    if (!this.configured) throw new Error('Lemon Squeezy API key is not configured.');
    const storeId = this.storeId || (/^\d+$/.test(String(siteId)) ? String(siteId) : '');
    if (!storeId) {
      throw new Error('Lemon Squeezy store id missing. Pass a numeric siteId or set LEMONSQUEEZY_STORE_ID.');
    }
    if (!this.variantId) {
      throw new Error('Lemon Squeezy variant id missing. Set LEMONSQUEEZY_VARIANT_ID for the checkout variant.');
    }
    const priceCents = Math.max(1, Math.round(Number(price) || 0));

    const res = await this.fetchImpl(LEMONSQUEEZY_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            custom_price: priceCents,
            checkout_data: {
              email: options.customerEmail,
              custom: { site_id: siteId, ...(options.metadata || {}) },
            },
            product_options: {
              name: options.productName,
              description: options.productDescription,
              redirect_url: replaceSessionPlaceholder(options.successUrl || '', '{LS_CHECKOUT_ID}'),
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: storeId } },
            variant: { data: { type: 'variants', id: this.variantId } },
          },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Lemon Squeezy error ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { id?: string; attributes?: { url?: string } };
    } | null;
    const id = String(body?.data?.id || '');
    const url = String(body?.data?.attributes?.url || '');
    if (!id || !url) throw new Error('Lemon Squeezy did not return a checkout url.');
    return {
      url: replaceSessionPlaceholder(url, id),
      sessionId: id,
      provider: this.provider,
    };
  }
}
