/**
 * ADAPTERS / EMAIL — facade over `services/email/*`.
 *
 * Same rationale as `lib/adapters/payment.ts`: `services/email/` already
 * implements the driver+registry+factory pattern (`types.ts`'s `EmailDriver`
 * → `resend.driver.ts` / `postmark.driver.ts` / `sendgrid.driver.ts` →
 * `registry.ts` → `factory.ts`'s `EmailFactory.getDriver()`). This re-exports
 * it under `lib/adapters/` rather than reimplementing it. Swapping to AWS SES
 * means adding a driver under `services/email/` and registering it — nothing
 * here changes.
 */

export type { EmailDriver, EmailMessage, EmailSendResult, CodeEmailOptions } from '@/services/email/types';
export { EmailFactory } from '@/services/email/factory';

import { EmailFactory } from '@/services/email/factory';
import type { EmailDriver } from '@/services/email/types';

/** Resolve the active email adapter (wizard-configured → env fallback → null). */
export function getEmailAdapter(opts?: { force?: boolean }): Promise<EmailDriver | null> {
  return EmailFactory.getDriver(opts);
}
