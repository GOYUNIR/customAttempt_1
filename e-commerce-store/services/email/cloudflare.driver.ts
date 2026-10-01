/**
 * SERVICES / EMAIL — Cloudflare Email Service driver (Workers `send_email`
 * binding). Public beta at the time of writing.
 *
 * Docs: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *   wrangler.jsonc: "send_email": [{ "name": "EMAIL" }]
 *   env.EMAIL.send({ to, from, replyTo, subject, html, text }) -> { messageId }
 *   errors are thrown with `.code`, e.g. E_DAILY_LIMIT_EXCEEDED.
 *
 * Needs Workers Paid to send to arbitrary recipients (3,000/month included,
 * then $0.35 per 1,000), and the sending domain onboarded to Email Service.
 * The binding is injected (`getBinding`) so node --test runs this without
 * Workers; outside Workers it is absent and the driver reports unconfigured,
 * so the governed driver moves on to the fallback provider.
 */
import type { EmailDriver, EmailMessage, CodeEmailOptions, EmailSendResult, EmailProviderId } from './types.ts';
import { buildCodeEmailHtml, DEFAULT_EMAIL_BRAND } from './types.ts';

export interface SendEmailBinding {
  send(message: {
    to: string; from: string | { email: string; name?: string }; replyTo?: string;
    subject: string; html?: string; text?: string;
  }): Promise<{ messageId?: string }>;
}

/** "Name <a@b.c>" -> { email, name }; a bare address stays a string. */
export function parseFrom(from: string): string | { email: string; name?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
  return m ? { email: m[2].trim(), ...(m[1].trim() ? { name: m[1].trim() } : {}) } : String(from || '').trim();
}

/**
 * How a thrown Email Service error is treated by the governed driver:
 *   E_DAILY_LIMIT_EXCEEDED                         -> 'full'
 *   E_TOO_MANY_RECIPIENTS, E_CONTENT_TOO_LARGE, an
 *   invalid address                                -> 'rejected' (the message)
 *   everything else (rate limit, sender/domain not
 *   onboarded, internal, network)                  -> 'transient' (next provider)
 */
export function cloudflareFailureKind(code: string): 'full' | 'transient' | 'rejected' {
  if (code === 'E_DAILY_LIMIT_EXCEEDED') return 'full';
  if (code === 'E_TOO_MANY_RECIPIENTS' || code === 'E_CONTENT_TOO_LARGE' || /INVALID_(RECIPIENT|ADDRESS|TO)/.test(code)) return 'rejected';
  return 'transient';
}

export class CloudflareEmailDriver implements EmailDriver {
  readonly provider: EmailProviderId = 'cloudflare';
  readonly configured: boolean;
  private readonly binding: SendEmailBinding | null;
  private readonly defaultFrom: string;
  private readonly brandName: string;
  constructor(binding: SendEmailBinding | null, defaultFrom = '', brandName = DEFAULT_EMAIL_BRAND) {
    this.binding = binding;
    this.defaultFrom = defaultFrom;
    this.brandName = brandName;
    this.configured = Boolean(binding && typeof binding.send === 'function' && defaultFrom);
  }

  async send2FA(to: string, code: string, options?: CodeEmailOptions): Promise<EmailSendResult> {
    return this.sendTransactional({
      to, from: this.defaultFrom, subject: options?.subject || `Your verification code: ${code}`,
      html: buildCodeEmailHtml({ code, headline: options?.headline, body: options?.body, ctaLabel: options?.ctaLabel, ctaUrl: options?.ctaUrl, brandName: options?.brandName || this.brandName, logoUrl: options?.logoUrl }),
      meta: options?.meta,
    });
  }

  async sendTransactional(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.configured || !this.binding) return { ok: false, skipped: true, error: 'Cloudflare Email Service is not set up.', provider: this.provider, failure: 'transient' };
    try {
      const out = await this.binding.send({
        to: message.to,
        from: parseFrom(message.from || this.defaultFrom),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        ...(message.text ? { text: message.text } : {}),
      });
      return { ok: true, id: out?.messageId, provider: this.provider };
    } catch (err: any) {
      const code = String(err?.code || '');
      return { ok: false, error: (code ? code + ': ' : '') + String(err?.message || err), provider: this.provider, failure: cloudflareFailureKind(code) };
    }
  }
}
