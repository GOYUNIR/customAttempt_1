/**
 * SERVICES / EMAIL â€” SendGrid driver (REST, fetch-based â€” no SDK).
 *
 * API: POST https://api.sendgrid.com/v3/mail/send
 * Docs: https://docs.sendgrid.com/api-reference/mail-send/mail-send
 * Auth:  header `Authorization: Bearer <api key>`
 *
 * SendGrid requires a VERIFIED sender address; `EMAIL_FROM` / `RESEND_FROM`
 * should be set. `fetchImpl` is injectable for tests.
 */

import type { EmailDriver, EmailMessage, CodeEmailOptions, EmailSendResult } from './types.ts';
import { buildCodeEmailHtml, DEFAULT_EMAIL_BRAND } from './types.ts';
import type { MailProvider } from '../config/types.ts';

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send';

export interface SendGridDriverOptions {
  apiKey: string;
  from?: string;
  brandName?: string;
  fetchImpl?: typeof fetch;
}

export class SendGridDriver implements EmailDriver {
  readonly provider: MailProvider = 'sendgrid';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly defaultFrom: string;
  private readonly brandName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SendGridDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.defaultFrom = options.from || `noreply@${options.brandName || DEFAULT_EMAIL_BRAND}.com`;
    this.brandName = options.brandName || DEFAULT_EMAIL_BRAND;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async send2FA(to: string, code: string, options?: CodeEmailOptions): Promise<EmailSendResult> {
    return this.sendTransactional({
      to,
      from: this.defaultFrom,
      subject: options?.subject || `Your verification code: ${code}`,
      html: buildCodeEmailHtml({
        code,
        headline: options?.headline,
        body: options?.body,
        ctaLabel: options?.ctaLabel,
        ctaUrl: options?.ctaUrl,
        brandName: options?.brandName || this.brandName,
        logoUrl: options?.logoUrl,
      }),
    });
  }

  async sendTransactional(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.configured) {
      return { ok: false, error: 'SendGrid API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const res = await this.fetchImpl(SENDGRID_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }], subject: message.subject }],
          from: { email: message.from || this.defaultFrom },
          reply_to: message.replyTo ? { email: message.replyTo } : undefined,
          content: [{ type: message.text ? 'text/plain' : 'text/html', value: message.text || message.html }],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `SendGrid error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      return { ok: true, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
