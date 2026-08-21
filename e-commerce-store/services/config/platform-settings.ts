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
  sanitizeMailProvider,
  sanitizePaymentProvider,
  sanitizeMapProvider,
  type GlobalPlatformSettings,
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
  const mailProvider = sanitizeMailProvider(raw.mail_provider);
  if (!mailProvider) return { ok: false, error: 'Choose a valid email provider.' };
  const mailApiKey = String(raw.mail_api_key || '').trim();
  if (!mailApiKey) return { ok: false, error: 'Enter an email provider API key.' };

  const paymentProvider = sanitizePaymentProvider(raw.payment_provider);
  if (!paymentProvider) return { ok: false, error: 'Choose a valid payment provider.' };
  const paymentApiKey = String(raw.payment_api_key || '').trim();
  if (!paymentApiKey) return { ok: false, error: 'Enter a payment provider API key.' };
  const paymentWebhookSecret = String(raw.payment_webhook_secret || '').trim();

  const mapProvider = sanitizeMapProvider(raw.map_provider);
  if (!mapProvider) return { ok: false, error: 'Choose a valid map provider.' };
  const mapApiKey = String(raw.map_api_key || '').trim();
  if (mapProvider !== 'open_street_map' && !mapApiKey) {
    return { ok: false, error: 'Enter a map provider API key.' };
  }

  return {
    ok: true,
    input: {
      mail_provider: mailProvider,
      mail_api_key: mailApiKey,
      payment_provider: paymentProvider,
      payment_api_key: paymentApiKey,
      payment_webhook_secret: paymentWebhookSecret || undefined,
      map_provider: mapProvider,
      map_api_key: mapApiKey || undefined,
    },
  };
}

/** Persist the settings row WITHOUT flipping the configured flag. */
export async function savePlatformSettings(input: PlatformSettingsInput): Promise<void> {
  await upsertPlatformSettingsRow({
    id: GLOBAL_PLATFORM_SETTINGS_ROW_ID,
    is_configured: false,
    mail_provider: input.mail_provider,
    mail_api_key: input.mail_api_key,
    payment_provider: input.payment_provider,
    payment_api_key: input.payment_api_key,
    payment_webhook_secret: input.payment_webhook_secret || null,
    map_provider: input.map_provider,
    map_api_key: input.map_api_key || null,
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
