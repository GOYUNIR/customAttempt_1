/**
 * SERVICES / EMAIL — public barrel.
 * Functional features import `EmailFactory` + the `EmailDriver` contract from
 * here; the concrete drivers stay importable for advanced/Stripe-style use.
 */
export { EmailFactory } from './factory';
export * from './types';
export { createEmailDriver, EMAIL_DRIVER_CATALOG } from './registry';
export { ResendDriver } from './resend.driver';
export { PostmarkDriver } from './postmark.driver';
export { SendGridDriver } from './sendgrid.driver';
