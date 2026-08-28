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

/**
 * Enumerated AI providers — mirrors the SQL check constraint.
 *
 * `deepseek` is "DeepSeek Pro" (the DEFAULT PRIMARY) and `deepseek_lite` is the
 * cheaper "DeepSeek Lite" (the DEFAULT SECONDARY fallback). Both hit the same
 * DeepSeek OpenAI-compatible endpoint and share `DEEPSEEK_API_KEY`.
 */
export type AiProvider =
  | 'deepseek'
  | 'deepseek_lite'
  | 'openai'
  | 'anthropic'
  | 'replicate'
  | 'workers_ai'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'google_gemini';

/** Every provider union in one place for validation loops. */
export const MAIL_PROVIDERS: readonly MailProvider[] = ['resend', 'postmark', 'sendgrid'];
export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = ['stripe', 'lemon_squeezy', 'paddle'];
export const MAP_PROVIDERS: readonly MapProvider[] = ['mapbox', 'google_maps', 'open_street_map'];
export const AI_PROVIDERS: readonly AiProvider[] = [
  'deepseek',
  'deepseek_lite',
  'openai',
  'anthropic',
  'replicate',
  'workers_ai',
  'openrouter',
  'groq',
  'mistral',
  'google_gemini',
];

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
  /** Optional SECONDARY (fallback) AI provider — tried when the primary fails. */
  ai_provider_secondary: AiProvider | null;
  ai_api_key_secondary: string | null;
  /**
   * Operational (env-var-style) settings the unified setup dashboard persists.
   * Stored as a JSONB blob on the settings row — never returned to the browser
   * by `toPublicSummary()`.
   */
  operational_settings?: OperationalSettings | null;
  created_at?: string;
  updated_at?: string;
}

/** The payload the Setup Wizard POSTs. Provider + key triples per category. */
export interface PlatformSettingsInput {
  mail_provider: MailProvider | null;
  mail_api_key: string | null;
  /** `null` = payments skipped for now (no payment provider configured yet). */
  payment_provider: PaymentProvider | null;
  payment_api_key: string | null;
  payment_webhook_secret?: string;
  map_provider: MapProvider | null;
  map_api_key?: string;
  /** The PRIMARY AI provider (optional — the storefront uses built-in CSS/SVG presets when null). */
  ai_provider: AiProvider | null;
  ai_api_key: string | null;
  /** Optional secondary fallback AI provider (tried when the primary fails). */
  ai_provider_secondary: AiProvider | null;
  ai_api_key_secondary?: string;
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
  ai_provider_secondary: AiProvider | null;
}

/** Strip every secret from a settings row → safe for client responses. */
export function toPublicSummary(settings: GlobalPlatformSettings | null | undefined): PlatformSettingsPublicSummary {
  return {
    is_configured: Boolean(settings?.is_configured),
    mail_provider: settings?.mail_provider ?? null,
    payment_provider: settings?.payment_provider ?? null,
    map_provider: settings?.map_provider ?? null,
    ai_provider: settings?.ai_provider ?? null,
    ai_provider_secondary: settings?.ai_provider_secondary ?? null,
  };
}

/**
 * Operational (env-var-style) settings the unified setup dashboard persists.
 * These mirror `process.env` variables that cannot be written at runtime, so
 * the wizard stores them in `global_platform_settings.operational_settings`
 * for reference/backup AND surfaces the exact `npx wrangler secret put` /
 * `vercel env add` commands to set them in the platform.
 */
export interface OperationalSettings {
  storage_provider?: string;
  storage_replicas?: string;
  upstash_redis_rest_url?: string;
  upstash_redis_rest_token?: string;
  cloudflare_kv_binding?: string;
  cloudflare_d1_binding?: string;
  admin_basic_auth_password?: string;
  admin_verify_email?: string;
  cron_secret?: string;
  site_url?: string;
  brand_name?: string;
  support_email?: string;
  stripe_secret_key?: string;
  stripe_webhook_secret?: string;
  stripe_product_id?: string;
  deepseek_api_key?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  replicate_api_token?: string;
  workers_ai_account_id?: string;
  workers_ai_api_token?: string;
  openrouter_api_key?: string;
  groq_api_key?: string;
  mistral_api_key?: string;
  google_gemini_api_key?: string;
  [key: string]: string | undefined;
}

/** The whitelisted operational keys the wizard may persist (never arbitrary). */
export const OPERATIONAL_SETTING_KEYS: readonly string[] = [
  'storage_provider',
  'storage_replicas',
  'upstash_redis_rest_url',
  'upstash_redis_rest_token',
  'cloudflare_kv_binding',
  'cloudflare_d1_binding',
  'admin_basic_auth_password',
  'admin_verify_email',
  'cron_secret',
  'site_url',
  'brand_name',
  'support_email',
  'stripe_secret_key',
  'stripe_webhook_secret',
  'stripe_product_id',
  'deepseek_api_key',
  'openai_api_key',
  'anthropic_api_key',
  'replicate_api_token',
  'workers_ai_account_id',
  'workers_ai_api_token',
  'openrouter_api_key',
  'groq_api_key',
  'mistral_api_key',
  'google_gemini_api_key',
];

/** Coerce an untrusted operational_settings blob → typed shape (drop unknown keys + blanks). */
export function parseOperationalSettings(raw: unknown): OperationalSettings {
  const out: OperationalSettings = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const key of OPERATIONAL_SETTING_KEYS) {
    const v = String(src[key] ?? '').trim();
    if (v) out[key] = v;
  }
  return out;
}

/** Whether an operational_settings blob holds any real values (presence badge). */
export function hasOperationalSettings(settings: OperationalSettings | null | undefined): boolean {
  return Boolean(settings && Object.keys(settings).length > 0);
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
    ai_provider_secondary: sanitizeAiProvider(raw.ai_provider_secondary),
    ai_api_key_secondary: sanitizeAiProvider(raw.ai_provider_secondary) ? String(raw.ai_api_key_secondary || '').trim() || null : null,
    operational_settings: parseOperationalSettings(raw.operational_settings),
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

/**
 * DeepSeek Pro (`deepseek`) and DeepSeek Lite (`deepseek_lite`) are the SAME
 * DeepSeek OpenAI-compatible API — one `DEEPSEEK_API_KEY`, two tiers. This
 * helper lets the wizard + factory treat them as a single keyed provider so the
 * operator only ever enters the DeepSeek key once and can switch Pro ↔ Lite
 * freely.
 */
export function isDeepSeekProvider(provider: AiProvider | null | undefined): boolean {
  return provider === 'deepseek' || provider === 'deepseek_lite';
}
