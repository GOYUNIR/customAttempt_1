/**
 * SERVICES / EMAIL — the sink: a recording driver that never sends.
 *
 * Used by the governed driver (governor.ts) for every recipient on a reserved
 * test domain, and for ALL mail when a simulation sets EMAIL_DRIVER=record.
 * Each message is handed to `store` (the factory writes it to the
 * `email_sink` table) so a proof can read back exactly what a customer would
 * have received: sender, reply-to, subject and body.
 */
import type { EmailDriver, EmailMessage, CodeEmailOptions, EmailSendResult, EmailProviderId } from './types.ts';
import { buildCodeEmailHtml, DEFAULT_EMAIL_BRAND } from './types.ts';

export class SinkDriver implements EmailDriver {
  readonly provider: EmailProviderId = 'sink';
  readonly configured = true;
  private readonly store: (m: EmailMessage) => Promise<string | void>;
  private readonly defaultFrom: string;
  private readonly brandName: string;
  constructor(store: (m: EmailMessage) => Promise<string | void>, defaultFrom = '', brandName = DEFAULT_EMAIL_BRAND) {
    this.store = store;
    this.defaultFrom = defaultFrom;
    this.brandName = brandName;
  }

  async send2FA(to: string, code: string, options?: CodeEmailOptions): Promise<EmailSendResult> {
    return this.sendTransactional({
      to, from: this.defaultFrom, subject: options?.subject || `Your verification code: ${code}`,
      html: buildCodeEmailHtml({ code, headline: options?.headline, body: options?.body, ctaLabel: options?.ctaLabel, ctaUrl: options?.ctaUrl, brandName: options?.brandName || this.brandName, logoUrl: options?.logoUrl }),
      meta: options?.meta,
    });
  }

  async sendTransactional(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const id = await this.store({ ...message, from: message.from || this.defaultFrom });
      return { ok: true, id: id || undefined, provider: this.provider };
    } catch (error) {
      return { ok: false, error, provider: this.provider, failure: 'transient' };
    }
  }
}
