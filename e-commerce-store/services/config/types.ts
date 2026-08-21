/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SERVICES / CONFIG — shared provider types
 *
 * The driver-engine contracts shared by the email / payment / map service
 * wrappers. The provider strings here are the EXACT values the Setup Wizard
 * writes into `public.global_platform_settings` (see
 * multi-tenant-platform/supabase/migrations/00003_global_platform_settings.sql).
 *
 * This file has ZERO imports on purpose so it stays edge-safe and loadable by
 * the `node --test` runner (no `@/` alias).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Enumerated email providers — mirrors the SQL check constraint. */
export type MailProvider = 'resend' | 'postmark' | 'sendgrid';

/** Enumerated payment providers — mirrors the SQL check constraint. */
export type PaymentProvider = 'stripe' | 'lemon_squeezy' | 'paddle';

/** Enumerated map providers — mirrors the SQL check constraint. */
export type MapProvider = 'mapbox' | 'google_maps' | 'open_street_map';

/** Enumerated AI providers — mirrors the SQL check constraint. */
export type AiProvider = 'deepseek' | 'openai' | 'anthropic' | 'replicate' | 'workers_ai';

/** Every provider union in one place for validation loops. */
export const MAIL_PROVIDERS: readonly MailProvider[] = ['resend', 'postmark', 'sendgrid'];
export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = ['stripe', 'lemon_squeezy', 'paddle'];
export const MAP_PROVIDERS: readonly MapProvider[] = ['mapbox', 'google_maps', 'open_street_map'];
export const AI_PROVIDERS: readonly AiProvider[] = ['deepseek', 'openai', 'anthropic', 'replicate', 'workers_ai'];

/**
 * The row shape of `public.global_platform_settings`. API keys are returned
 * EXACTLY as stored (the driver factories are the only consumers; they run
 * server-side). The Setup Wizard UI never receives the key VALUES — only the
 * provider names (see `PlatformSettingsPublicSummary`).
 */
export interface GlobalPlatformSettings {
  id: string;
  is_configured: boolean;
  mail_provider: MailProvider | null;
  mail_api_key: string | null;
  payment_provider: PaymentProvider | null;
  payment_api_key: string | null;
  payment_webhook_secret: string | null;
  map_provider: MapProvider | null;
  map_api_key: string | null;
  ai_provider: AiProvider | null;
  ai_api_key: string | null;
  created_at?: string;
  updated_at?: string;
}

/** The payload the Setup Wizard POSTs. Provider + key triples per category. */
export interface PlatformSettingsInput {
  mail_provider: MailProvider;
  mail_api_key: string;
  payment_provider: PaymentProvider;
  payment_api_key: string;
  payment_webhook_secret?: string;
  map_provider: MapProvider;
  map_api_key?: string;
  ai_provider: AiProvider;
  ai_api_key?: string;
}

/**
 * The single global settings row is upserted under ONE fixed id so the
 * singleton unique index and the app both know where to read/write it.
 */
export const GLOBAL_PLATFORM_SETTINGS_ROW_ID = '00000000-0000-0000-0000-0000000000c0';

/**
 * A value the API exposes to the Setup Wizard / admin portal — provider names
 * and flags, NEVER the stored secrets.
 */
export interface PlatformSettingsPublicSummary {
  is_configured: boolean;
  mail_provider: MailProvider | null;
  payment_provider: PaymentProvider | null;
  map_provider: MapProvider | null;
  ai_provider: AiProvider | null;
}

/** Strip every secret from a settings row → safe for client responses. */
export function toPublicSummary(settings: GlobalPlatformSettings | null | undefined): PlatformSettingsPublicSummary {
  return {
    is_configured: Boolean(settings?.is_configured),
    mail_provider: settings?.mail_provider ?? null,
    payment_provider: settings?.payment_provider ?? null,
    map_provider: settings?.map_provider ?? null,
    ai_provider: settings?.ai_provider ?? null,
  };
}

/** Coerce an untrusted raw row (PostgREST JSON) into the typed shape. */
export function parseSettingsRow(raw: Record<string, unknown> | null | undefined): GlobalPlatformSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!id) return null;
  const mailProvider = sanitizeMailProvider(raw.mail_provider);
  const paymentProvider = sanitizePaymentProvider(raw.payment_provider);
  const mapProvider = sanitizeMapProvider(raw.map_provider);
  const aiProvider = sanitizeAiProvider(raw.ai_provider);
  return {
    id,
    is_configured: raw.is_configured === true,
    mail_provider: mailProvider,
    mail_api_key: mailProvider ? String(raw.mail_api_key || '').trim() || null : null,
    payment_provider: paymentProvider,
    payment_api_key: paymentProvider ? String(raw.payment_api_key || '').trim() || null : null,
    payment_webhook_secret: paymentProvider === 'stripe' ? String(raw.payment_webhook_secret || '').trim() || null : null,
    map_provider: mapProvider,
    map_api_key: mapProvider ? String(raw.map_api_key || '').trim() || null : null,
    ai_provider: aiProvider,
    ai_api_key: aiProvider ? String(raw.ai_api_key || '').trim() || null : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : undefined,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
  };
}

/** Validate a mail provider string (returns null when not in the enum). */
export function sanitizeMailProvider(value: unknown): MailProvider | null {
  const v = String(value || '').trim().toLowerCase();
  return (MAIL_PROVIDERS as readonly string[]).includes(v) ? (v as MailProvider) : null;
}

/** Validate a payment provider string (returns null when not in the enum). */
export function sanitizePaymentProvider(value: unknown): PaymentProvider | null {
  const v = String(value || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  return (PAYMENT_PROVIDERS as readonly string[]).includes(v) ? (v as PaymentProvider) : null;
}

/** Validate a map provider string (returns null when not in the enum). */
export function sanitizeMapProvider(value: unknown): MapProvider | null {
  const v = String(value || '').trim().toLowerCase();
  return (MAP_PROVIDERS as readonly string[]).includes(v) ? (v as MapProvider) : null;
}

/** Validate an AI provider string (returns null when not in the enum). */
export function sanitizeAiProvider(value: unknown): AiProvider | null {
  const v = String(value || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  return (AI_PROVIDERS as readonly string[]).includes(v) ? (v as AiProvider) : null;
}
