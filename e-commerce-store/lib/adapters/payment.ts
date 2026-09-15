/**
 * ADAPTERS / PAYMENT — facade over `services/payment/*`.
 *
 * `services/payment/` already implements the interface-adapter pattern in
 * full (`types.ts`'s `PaymentDriver` contract → `stripe.driver.ts` /
 * `lemon-squeezy.driver.ts` / `paddle.driver.ts` → `registry.ts` →
 * `factory.ts`'s `PaymentFactory.getDriver()`). This file does not duplicate
 * that — it re-exports it under `lib/adapters/` so the vendor-flexible
 * surface area lives at one predictable import path alongside the other
 * adapters. Swapping to Adyen/Braintree/Authorize.net means adding a driver
 * under `services/payment/` (implementing `PaymentDriver`) and registering
 * it in `services/payment/registry.ts` — nothing here changes.
 */

export type { PaymentDriver, CheckoutSessionOptions, CheckoutSessionResult } from '@/services/payment/types';
export { PaymentFactory } from '@/services/payment/factory';

import { PaymentFactory } from '@/services/payment/factory';
import type { PaymentDriver } from '@/services/payment/types';

/** Resolve the active payment adapter (wizard-configured → env fallback → null). */
export function getPaymentAdapter(opts?: { force?: boolean }): Promise<PaymentDriver | null> {
  return PaymentFactory.getDriver(opts);
}
