/**
 * SERVICES / CONFIG — platform settings store (cached).
 *
 * The runtime factory entry point. Every driver factory (EmailFactory,
 * PaymentFactory, MapFactory) resolves its active provider through
 * `getPlatformSettings()`:
 *
 *   1. reads `public.global_platform_settings` (service role, REST)
 *   2. CACHES the result in memory (TTL) so the database is not slammed on
 *      every email / checkout / map operation
 *   3. falls back to the legacy env-var providers when Supabase is absent or a
 *      category is unset (RESEND_API_KEY / STRIPE_SECRET_KEY / …) so an
 *      existing store never breaks.
 *
 * The cache is a module-level Map with an explicit TTL and a real `clear()`
 * path — write operations invalidate it so wizard results are visible
 * immediately. Edge-safe: no Node builtins.
 */

import {
  fetchPlatformSettingsRow,
  fetchIsPlatformConfigured,
  upsertPlatformSettingsRow,
} from './supabase-client.ts';
import {
  GLOBAL_PLATFORM_SETTINGS_ROW_ID,
  parseSettingsRow,
  parseOperationalSettings,
  sanitizeMailProvider,
  sanitizePaymentProvider,
  sanitizeMapProvider,
  sanitizeAiProvider,
  isDeepSeekProvider,
  type GlobalPlatformSettings,
  type OperationalSettings,
  type PlatformSettingsInput,
} from './types.ts';

const SETTINGS_CACHE_KEY = 'services:global_platform_settings';
const CONFIGURED_CACHE_KEY = 'services:is_platform_configured';

export const SETTINGS_CACHE_TTL_MS = 60_000;
export const CONFIGURED_CACHE_TTL_MS = 5_000;

type CacheEntry<T> = { value: T; expiresAt: number };
const localSettingsCache = new Map<string, CacheEntry<GlobalPlatformSettings | null>>();
const localConfiguredCache = new Map<string, CacheEntry<boolean | null>>();

async function cachedFetch<T>(map: Map<string, CacheEntry<T>>, key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = map.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await fetcher();
  map.set(key, { value, expiresAt: now + ttlMs });
  if (map.size > 100) {
    for (const [k, entry] of map) {
      if (entry.expiresAt <= now) map.delete(k);
    }
  }
  return value;
}

/** Read the single settings row (TTL-cached). Null when Supabase is unset. */
export async function getPlatformSettings(opts?: { force?: boolean }): Promise<GlobalPlatformSettings | null> {
  if (opts?.force) localSettingsCache.clear();
  return cachedFetch(localSettingsCache, SETTINGS_CACHE_KEY, SETTINGS_CACHE_TTL_MS, async () => {
    const row = await fetchPlatformSettingsRow();
    return row ? parseSettingsRow(row) : null;
  });
}

/** Whether the platform has been configured — the Setup Wizard gate. */
export async function isPlatformConfigured(opts?: { force?: boolean }): Promise<boolean | null> {
  if (opts?.force) localConfiguredCache.clear();
  return cachedFetch(localConfiguredCache, CONFIGURED_CACHE_KEY, CONFIGURED_CACHE_TTL_MS, fetchIsPlatformConfigured);
}

/**
 * Normalize + validate a wizard payload. Returns a validated input object or a
 * `{ error }` describing the first problem.
 */
export function normalizePlatformSettingsInput(raw: Record<string, unknown>):
  | { ok: true; input: PlatformSettingsInput }
  | { ok: false; error: string } {
  // Email is OPTIONAL - a missing / blank / 'none' provider means "skip for
  // now": the store sends no transactional email until one is configured later.
  const mailRaw = String(raw.mail_provider ?? '').trim();
  const isMailSkip = !mailRaw || mailRaw.toLowerCase() === 'none';
  const mailProvider = isMailSkip ? null : sanitizeMailProvider(raw.mail_provider);
  if (!isMailSkip && !mailProvider) return { ok: false, error: 'Choose a valid email provider.' };
  const mailApiKey = isMailSkip ? null : String(raw.mail_api_key || '').trim();
  if (mailProvider && !mailApiKey) return { ok: false, error: 'Enter an email provider API key.' };

  // Payments are OPTIONAL. A missing / blank / 'none' provider means "skip
  // payments for now" — checkout simply won't run until one is configured.
  const paymentRaw = String(raw.payment_provider ?? '').trim();
  const isPaymentSkip = !paymentRaw || paymentRaw.toLowerCase() === 'none';
  const paymentProvider = isPaymentSkip ? null : sanitizePaymentProvider(raw.payment_provider);
  if (!isPaymentSkip && !paymentProvider) return { ok: false, error: 'Choose a valid payment provider.' };
  const paymentApiKey = String(raw.payment_api_key || '').trim();
  if (paymentProvider && !paymentApiKey) return { ok: false, error: 'Enter a payment provider API key.' };
  const paymentWebhookSecret = String(raw.payment_webhook_secret || '').trim();
  const stripePriceId = String(raw.stripe_price_id || '').trim();

  // Maps are OPTIONAL - a missing / blank / 'none' provider means "skip for
  // now": address autofill is simply disabled until one is configured.
  const mapRaw = String(raw.map_provider ?? '').trim();
  const isMapSkip = !mapRaw || mapRaw.toLowerCase() === 'none';
  const mapProvider = isMapSkip ? null : sanitizeMapProvider(raw.map_provider);
  if (!isMapSkip && !mapProvider) return { ok: false, error: 'Choose a valid map provider.' };
  const mapApiKey = String(raw.map_api_key || '').trim();
  if (mapProvider && mapProvider !== 'open_street_map' && !mapApiKey) {
    return { ok: false, error: 'Enter a map provider API key.' };
  }

  // AI is OPTIONAL - a missing / blank / 'none' provider means "skip for now":
  // the storefront falls back to the built-in CSS/SVG animation presets until
  // an AI provider is configured.
  const aiRaw = String(raw.ai_provider ?? '').trim();
  const isAiSkip = !aiRaw || aiRaw.toLowerCase() === 'none';
  const aiProvider = isAiSkip ? null : sanitizeAiProvider(raw.ai_provider);
  if (!isAiSkip && !aiProvider) return { ok: false, error: 'Choose a valid AI provider.' };
  const aiApiKey = String(raw.ai_api_key || '').trim();
  if (aiProvider && aiProvider !== 'workers_ai' && !aiApiKey) {
    return { ok: false, error: 'Enter an AI provider API key (Workers AI needs none).' };
  }

  // The SECONDARY fallback provider is OPTIONAL. When set, its key is required
  // (Workers AI excepted). Blank / 'none' means "no secondary".
  const aiSecondaryRaw = String(raw.ai_provider_secondary ?? '').trim();
  const aiProviderSecondary =
    !aiSecondaryRaw || aiSecondaryRaw.toLowerCase() === 'none'
      ? null
      : sanitizeAiProvider(raw.ai_provider_secondary);
  const aiApiKeySecondary = String(raw.ai_api_key_secondary || '').trim();
  if (aiProviderSecondary && aiProviderSecondary !== 'workers_ai' && !aiApiKeySecondary) {
    // DeepSeek Pro and DeepSeek Lite share ONE key — a DeepSeek secondary reuses
    // the primary DeepSeek key when its own field is left empty, so the operator
    // only ever enters the DeepSeek key once. Any other provider still needs its
    // own secondary key.
    const reusesPrimaryDeepSeekKey =
      isDeepSeekProvider(aiProviderSecondary) && isDeepSeekProvider(aiProvider) && Boolean(aiApiKey);
    if (!reusesPrimaryDeepSeekKey) {
      return { ok: false, error: 'Enter a secondary AI provider API key (Workers AI needs none), or clear the secondary provider.' };
    }
  }

  return {
    ok: true,
    input: {
      mail_provider: mailProvider,
      mail_api_key: mailProvider ? mailApiKey : null,
      payment_provider: paymentProvider,
      payment_api_key: paymentProvider ? paymentApiKey : null,
      payment_webhook_secret: paymentWebhookSecret || undefined,
      stripe_price_id: stripePriceId || undefined,
      map_provider: mapProvider,
      map_api_key: mapProvider ? mapApiKey || undefined : undefined,
      ai_provider: aiProvider,
      ai_api_key: aiProvider ? aiApiKey : null,
      ai_provider_secondary: aiProviderSecondary,
      ai_api_key_secondary: aiProviderSecondary && aiApiKeySecondary ? aiApiKeySecondary : undefined,
    },
  };
}

/** Persist the settings row WITHOUT flipping the configured flag. */
export async function savePlatformSettings(input: PlatformSettingsInput): Promise<void> {
  // NOTE: `is_configured` is deliberately OMITTED. The upsert uses PostgREST
  // `resolution=merge-duplicates`, which only writes the columns present in this
  // payload — so the existing `is_configured` value is preserved. Writing
  // `is_configured: false` here would flip a configured store back to
  // "unconfigured", which the middleware readiness gate then reads as
  // SETUP_REQUIRED and bounces the admin portal to /admin/setup on the next
  // request (the "clicked Refresh → sent to setup panel" bug).
  await upsertPlatformSettingsRow({
    id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
    mail_provider: input.mail_provider,
    mail_api_key: input.mail_api_key,
    payment_provider: input.payment_provider,
    payment_api_key: input.payment_api_key,
    payment_webhook_secret: input.payment_webhook_secret || null,
    stripe_price_id: input.stripe_price_id || null,
    map_provider: input.map_provider,
    map_api_key: input.map_api_key || null,
    ai_provider: input.ai_provider,
    ai_api_key: input.ai_api_key || null,
    ai_provider_secondary: input.ai_provider_secondary || null,
    ai_api_key_secondary: input.ai_api_key_secondary || null,
  });
  clearPlatformSettingsCache();
}

/**
 * Extract + sanitize the operational (env-var-style) settings from a wizard
 * payload. Only whitelisted keys are kept and blank values are dropped, so an
 * operator can submit the full form without every field filled in.
 */
export function normalizeOperationalSettingsInput(raw: Record<string, unknown>): OperationalSettings {
  return parseOperationalSettings(raw);
}

/** Persist ONLY the operational_settings JSONB column (leaves is_configured untouched). */
export async function saveOperationalSettings(settings: OperationalSettings): Promise<void> {
  await upsertPlatformSettingsRow({
    id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
    operational_settings: settings as unknown as Record<string, unknown>,
  });
  clearPlatformSettingsCache();
}

/** Flip `is_configured = true` after the super-admin exists (Setup Wizard). */
export async function markPlatformConfigured(): Promise<void> {
  await upsertPlatformSettingsRow({
    id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
    is_configured: true,
  });
  clearPlatformSettingsCache();
}

/** Forget every cached settings snapshot (admin saves, wizard saves, wipes). */
export function clearPlatformSettingsCache(): void {
  localSettingsCache.clear();
  localConfiguredCache.clear();
}

/**
 * Resolve the global default Stripe price ID at runtime. Resolution order:
 *   1. The admin-saved `global_platform_settings.stripe_price_id` (Setup Wizard
 *      / admin "API Keys & Integrations").
 *   2. The legacy `STRIPE_PRODUCT_ID` env var.
 *   3. '' (callers apply their own placeholder / error handling).
 *
 * Async because the DB value lives on the settings row; a missing/inaccessible
 * Supabase simply falls through to the env var (and then '').
 */
export async function resolveDefaultStripePriceId(): Promise<string> {
  const settings = await getPlatformSettings().catch(() => null);
  const db = String(settings?.stripe_price_id || '').trim();
  if (db) return db;
  return (process.env.STRIPE_PRODUCT_ID || '').trim();
}

/**
 * Resolve the effective Stripe price ID for a category: an explicit per-size ID
 * always wins, otherwise the admin/env default is used. Empty when nothing is
 * configured (mirrors the sync `resolveStripePriceId` in lib/server-config, but
 * also consults the DB-backed default price ID).
 */
export async function resolveStripePriceIdWithSettings(stored?: string | null): Promise<string> {
  const raw = typeof stored === 'string' ? stored.trim() : '';
  if (raw && !raw.startsWith('price_placeholder')) return raw;
  return resolveDefaultStripePriceId();
}
