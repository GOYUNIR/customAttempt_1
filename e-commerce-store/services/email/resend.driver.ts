/**
 * SERVICES / EMAIL â€” Resend driver (REST, fetch-based â€” no SDK).
 *
 * API: POST https://api.resend.com/emails
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 *
 * The `fetchImpl` option exists so the node --test runner can inject a fake
 * fetch and assert request shape without any network.
 */

import type { EmailDriver, EmailMessage, CodeEmailOptions, EmailSendResult } from './types.ts';
import { buildCodeEmailHtml, DEFAULT_EMAIL_BRAND } from './types.ts';
import type { MailProvider } from '../config/types.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';

export interface ResendDriverOptions {
  apiKey: string;
  /** Default From address used when a message omits one. */
  from?: string;
  brandName?: string;
  fetchImpl?: typeof fetch;
}

export class ResendDriver implements EmailDriver {
  readonly provider: MailProvider = 'resend';
  readonly configured: boolean;

  private readonly apiKey: string;
  private readonly defaultFrom: string;
  private readonly brandName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendDriverOptions) {
    this.apiKey = String(options.apiKey || '').trim();
    this.configured = Boolean(this.apiKey);
    this.defaultFrom = options.from || `${options.brandName || DEFAULT_EMAIL_BRAND} <onboarding@resend.dev>`;
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
      return { ok: false, error: 'Resend API key is not configured.', provider: this.provider, skipped: true };
    }
    try {
      const res = await this.fetchImpl(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from || this.defaultFrom,
          to: [message.to],
          reply_to: message.replyTo,
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `Resend error ${res.status}: ${detail.slice(0, 300)}`, provider: this.provider };
      }
      const data = (await res.json().catch(() => null)) as { id?: string } | null;
      return { ok: true, id: data?.id, provider: this.provider };
    } catch (err) {
      return { ok: false, error: err, provider: this.provider };
    }
  }
}
