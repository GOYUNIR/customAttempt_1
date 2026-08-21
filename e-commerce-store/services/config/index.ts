/**
 * SERVICES / CONFIG — public barrel.
 *
 * Everything the driver engine + Setup Wizard need to resolve the active
 * providers and the platform configuration gate:
 *
 *   types.ts              — MailProvider / PaymentProvider / MapProvider enums +
 *                           the global_platform_settings row shape
 *   platform-settings.ts  — TTL-cached settings store (get/save/mark configured)
 *   supabase-client.ts    — zero-SDK Supabase REST/Auth client + super-admin
 *                           creation + verification
 *   edge.ts               — edge-safe configuration gate for middleware.ts
 */

export * from './types';
export * from './platform-settings';
export * from './supabase-client';
export * from './edge';
