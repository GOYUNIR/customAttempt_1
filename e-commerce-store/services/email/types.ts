/**
 * SERVICES / EMAIL â€” the EmailDriver contract.
 *
 * Functional features NEVER call Resend / Postmark / SendGrid SDKs directly.
 * They resolve the active driver through `EmailFactory.getDriver()` and call
 * these two standardized methods:
 *
 *   send2FA(to, code)            â€” the one-time-code email (admin 2FA, customer
 *                                  email verification). The code is put in the
 *                                  SUBJECT so it shows in phone push-notification
 *                                  previews (matches the existing storefront
 *                                  convention).
 *   sendTransactional(message)   â€” any other transactional email (entry
 *                                  confirmed, winner, welcome, recovery, â€¦).
 *
 * This file has zero `@/` imports on purpose so the node --test runner can load
 * it directly.
 */

import type { MailProvider } from '../config/types.ts';

/** A normalized transactional email message (provider-agnostic). */
export interface EmailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
}

/** Overrides for the standardized 2FA code email. */
export interface CodeEmailOptions {
  /** Overrides the default `"Your verification code: <code>"` subject. */
  subject?: string;
  headline?: string;
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  /** Brand label shown in the email masthead. */
  brandName?: string;
}

/** Unified result shape every caller can switch on. */
export type EmailSendResult =
  | { ok: true; id?: string; provider: MailProvider }
  | { ok: false; error?: unknown; provider: MailProvider; skipped?: boolean };

export interface EmailDriver {
  readonly provider: MailProvider;
  /** Whether the driver has the secrets it needs to send. */
  readonly configured: boolean;
  /** Standardized one-time-code email (admin 2FA / customer verification). */
  send2FA(to: string, code: string, options?: CodeEmailOptions): Promise<EmailSendResult>;
  /** Standardized transactional email. */
  sendTransactional(message: EmailMessage): Promise<EmailSendResult>;
}

/** Brand label used in the 2FA template when the caller passes none. */
export const DEFAULT_EMAIL_BRAND = 'Store';

/** Shared build of the 2FA HTML â€” identical markup across every driver. */
export function buildCodeEmailHtml(options: {
  code: string;
  headline?: string;
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  brandName?: string;
}): string {
  const brand = (options.brandName || DEFAULT_EMAIL_BRAND).toUpperCase();
  const headline = options.headline || 'Your verification code';
  const body =
    options.body ||
    'Enter this one-time code to finish signing in. It expires in 10 minutes and can only be used once.';
  return `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
      <p style="letter-spacing:4px;font-size:12px;text-transform:uppercase;color:#6b7280;font-weight:700;margin:0 0 16px">${brand}</p>
      <h1 style="font-size:24px;font-weight:700;margin:0 0 10px">${headline}</h1>
      <p style="margin:0 0 14px;color:#4b5563">${body}</p>
      <div style="margin:0 0 18px;padding:16px 18px;border-radius:18px;background:#111;color:#fff;display:inline-block;font-weight:800;letter-spacing:6px;font-size:26px;text-align:center">${options.code}</div>
      <p style="margin:0 0 8px;color:#6b7280;font-size:12px">The code expires in 10 minutes and can only be used once. If you didn't request it, you can safely ignore this email.</p>
      ${options.ctaUrl ? `<p style="margin:0 0 20px"><a href="${options.ctaUrl}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:999px;font-weight:700;font-size:14px">${options.ctaLabel || 'Open'}</a></p>` : ''}
    </div>
  `;
}
