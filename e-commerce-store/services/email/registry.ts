/**
 * SERVICES / EMAIL â€” driver registry (pure factory helper).
 *
 * `createEmailDriver()` maps a provider string to its concrete driver. This
 * function is deliberately FREE of any `@/` import and of network/database
 * access so the `node --test` runner can load and exercise it directly â€” the
 * runtime `EmailFactory` (factory.ts) resolves the provider + key from the
 * platform settings and delegates here.
 */

import type { MailProvider } from '../config/types.ts';
import type { EmailDriver } from './types.ts';
import { ResendDriver, type ResendDriverOptions } from './resend.driver.ts';
import { PostmarkDriver, type PostmarkDriverOptions } from './postmark.driver.ts';
import { SendGridDriver, type SendGridDriverOptions } from './sendgrid.driver.ts';

export interface EmailDriverResolutionOptions {
  from?: string;
  brandName?: string;
  fetchImpl?: typeof fetch;
}

/** Resolve the provider string â†’ driver instance. Returns null for unknown. */
export function createEmailDriver(
  provider: MailProvider,
  apiKey: string,
  options: EmailDriverResolutionOptions = {},
): EmailDriver | null {
  const base = { from: options.from, brandName: options.brandName, fetchImpl: options.fetchImpl };
  switch (provider) {
    case 'resend':
      return new ResendDriver({ apiKey, ...base } as ResendDriverOptions);
    case 'postmark':
      return new PostmarkDriver({ apiKey, ...base } as PostmarkDriverOptions);
    case 'sendgrid':
      return new SendGridDriver({ apiKey, ...base } as SendGridDriverOptions);
    default:
      return null;
  }
}

/** Every supported provider (used by the Setup Wizard dropdowns + tests). */
export const EMAIL_DRIVER_CATALOG: ReadonlyArray<{ provider: MailProvider; label: string; hint: string }> = [
  { provider: 'resend', label: 'Resend', hint: 'developer-friendly API, onboarding@resend.dev sandbox' },
  { provider: 'postmark', label: 'Postmark', hint: 'fast transactional delivery â€” needs a verified sender' },
  { provider: 'sendgrid', label: 'SendGrid', hint: 'Twilio SendGrid v3 API' },
];
