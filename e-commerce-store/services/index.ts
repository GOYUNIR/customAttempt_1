/**
 * SERVICES — public barrel.
 *
 * The driver-based engine:
 *
 *   services/config    — `global_platform_settings` store (Supabase REST,
 *                        TTL-cached) + shared provider types
 *   services/email     — EmailDriver + Resend / Postmark / SendGrid + factory
 *   services/payment   — PaymentDriver + Stripe / LemonSqueezy / Paddle + factory
 *   services/maps      — MapDriver + Mapbox / GoogleMaps / OpenStreetMap + factory
 *
 * Functional features import from HERE (or from a subpath); they never touch
 * provider SDKs directly.
 */

export * from './config';
export { EmailFactory } from './email/factory';
export * from './email/types';
export { PaymentFactory, resolveStripeClient, resolvePaymentWebhookSecret } from './payment/factory';
export * from './payment/types';
export { MapFactory } from './maps/factory';
export * from './maps/types';
export { AiFactory, createAiDriver, AI_DRIVER_CATALOG } from './ai';
export * from './ai/types';
