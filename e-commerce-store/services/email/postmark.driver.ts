/**
 * SERVICES / EMAIL â€” Postmark driver (REST, fetch-based â€” no SDK).
 *
 * API: POST https://api.postmarkapp.com/email
 * Docs: https://postmarkapp.com/developer/api/email-api
 * Auth:  header `X-Postmark-Server-Token: <server token>`
 *
 * NOTE: Postmark only delivers from SENDERS VERIFIED on the account. If the
 * operator never sets `EMAIL_FROM` / `RESEND_FROM`, the driver falls back to a
 * neutral placeholder and Postmark rejects the send (the clear, correct signal
 * to configure a verified sender). `fetchImpl` is injectable for tests.
 */

import type { EmailDriver, EmailMessage, CodeEmailOptions, EmailSendResult } from './types.ts';
import { buildCodeEmailHtml, DEFAULT_EMAIL_BRAND } from './types.ts';
import type { MailProvider } from '../config/types.ts';

const POSTMARK_API_URL = 'https://api.postmarkapp.com/email';

export interface PostmarkDriverOptions {
  apiKey: string;
  from?: string;
  brandName?: string;
  fetchImpl?: typeof fetch;
}

export class PostmarkDriver implements EmailDriver {
  readonly provider: MailProvider = 'postmark';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly defaultFrom: string;
  private readonly brandName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PostmarkDriverOptions) {
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
      }),
    });
  }

  async sendTransactional(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.configured) {
      return { ok: false, error: 'Postmark API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const res = await this.fetchImpl(POSTMARK_API_URL, {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          From: message.from || this.defaultFrom,
          To: message.to,
          ReplyTo: message.replyTo,
          Subject: message.subject,
          HtmlBody: message.html,
          TextBody: message.text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Postmark error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const data = (await res.json().catch(() => null)) as { MessageID?: string } | null;
      return { ok: true, id: data?.MessageID, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
