/**
 * SERVICES / EMAIL — runtime factory.
 *
 * `EmailFactory.getDriver()` is the ONLY way functional features obtain an
 * email sender. Resolution order:
 *
 *   1. `global_platform_settings.mail_provider` + `.mail_api_key`
 *      (Setup Wizard) — read through the TTL-cached settings store.
 *   2. Legacy env fallback so an un-wizarded store keeps working:
 *        RESEND_API_KEY    → ResendDriver
 *        POSTMARK_API_KEY  → PostmarkDriver
 *        SENDGRID_API_KEY  → SendGridDriver
 *      (NEW_PUBLIC_* equivalents accepted for the Mapbox-style build-time pair.)
 *   3. null when nothing is configured → callers skip silently.
 *
 * The `from` address resolves `EMAIL_FROM` → `RESEND_FROM` → driver default.
 */

import { getBrandName } from '@/lib/env';
import { getPlatformSettings } from '@/services/config/platform-settings';
import type { MailProvider } from '@/services/config/types';
import { createEmailDriver, type EmailDriverResolutionOptions } from './registry';
import type { EmailDriver } from './types';

function resolveFromEnv(): string {
  return process.env.EMAIL_FROM || process.env.RESEND_FROM || '';
}

export class EmailFactory {
  /** Resolve the active email driver (cached settings; null when none). */
  static async getDriver(opts?: { force?: boolean }): Promise<EmailDriver | null> {
    const options: EmailDriverResolutionOptions = { brandName: getBrandName() || 'Store', from: resolveFromEnv() };

    // 1. Wizard-configured provider.
    const settings = await getPlatformSettings(opts);
    if (settings?.mail_provider && settings.mail_api_key) {
      return createEmailDriver(settings.mail_provider, settings.mail_api_key, options);
    }

    // 2. Legacy env fallbacks (template pre-dating the Setup Wizard).
    const envDrivers: Array<[MailProvider, string | undefined]> = [
      ['resend', process.env.RESEND_API_KEY],
      ['postmark', process.env.POSTMARK_API_KEY],
      ['sendgrid', process.env.SENDGRID_API_KEY],
    ];
    for (const [provider, key] of envDrivers) {
      if (key && String(key).trim()) {
        return createEmailDriver(provider, String(key).trim(), options);
      }
    }

    return null;
  }
}
