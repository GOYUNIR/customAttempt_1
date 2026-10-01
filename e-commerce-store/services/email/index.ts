/**
 * SERVICES / EMAIL — public barrel.
 * Functional features import `EmailFactory` + the `EmailDriver` contract from
 * here; the concrete drivers stay importable for advanced/Stripe-style use.
 */
export { EmailFactory, emailRoomFor, primaryEmailProvider, clearEmailPlanCache } from './factory';
export { GovernedEmailDriver, isSinkRecipient } from './governor';
export { SinkDriver } from './sink.driver';
export { CloudflareEmailDriver } from './cloudflare.driver';
export * from './types';
export { createEmailDriver, EMAIL_DRIVER_CATALOG } from './registry';
export { ResendDriver } from './resend.driver';
export { PostmarkDriver } from './postmark.driver';
export { SendGridDriver } from './sendgrid.driver';
