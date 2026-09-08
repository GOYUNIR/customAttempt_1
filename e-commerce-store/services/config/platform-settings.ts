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
  readSupabaseAccessToken,
} from './supabase-client.ts';
import {
  GLOBAL_PLATFORM_SETTINGS_ROW_ID,
  parseSettingsRow,
  parseOperationalSettings,
  sanitizeMailProvider,
  sanitizePaymentProvider,
  sanitizeMapProvider,
  sanitizeAiProvider,
  sanitizeAi3dProvider,
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
    // Never let a settings-read failure (or a malformed row) propagate into the
    // payment/email factories — checkout and transactional email must fall back
    // to legacy env keys rather than 500. `fetchPlatformSettingsRow` already
    // catches transport errors; this also guards a malformed row / parse throw.
    try {
      const row = await fetchPlatformSettingsRow();
      return row ? parseSettingsRow(row) : null;
    } catch {
      return null;
    }
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

  // The 3D asset / image-to-3D engine is OPTIONAL. A missing / blank / 'none'
  // provider means "no mesh engine": the hero degrades to the 2D image-texture
  // WebGL shader. When a provider is selected its API key is required.
  const ai3dRaw = String(raw.ai3d_provider ?? '').trim();
  const isAi3dSkip = !ai3dRaw || ai3dRaw.toLowerCase() === 'none';
  const ai3dProvider = isAi3dSkip ? null : sanitizeAi3dProvider(raw.ai3d_provider);
  if (!isAi3dSkip && !ai3dProvider) return { ok: false, error: 'Choose a valid 3D asset provider.' };
  const ai3dKey = String(raw.ai3d_key || '').trim();
  if (ai3dProvider && !ai3dKey) return { ok: false, error: 'Enter a 3D asset provider API key.' };
  const ai3dEndpoint = String(raw.ai3d_endpoint || '').trim();
  // Model selector for the PRIMARY LLM (not a secret — safe to store verbatim).
  const aiModel = String(raw.ai_model || '').trim();
  // Model selector for the 3D asset / image-to-3D engine (not a secret).
  const ai3dModel = String(raw.ai3d_model || '').trim();

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
      ai_model: aiModel || undefined,
      ai3d_provider: ai3dProvider,
      ai3d_key: ai3dProvider ? ai3dKey : null,
      ai3d_endpoint: ai3dEndpoint || undefined,
      ai3d_model: ai3dModel || undefined,
    },
  };
}

/**
 * Normalize a PARTIAL provider-keys update from the admin "API Keys &
 * Integrations" panel. API keys are write-only (the server never echoes the
 * stored VALUES back to the browser), so a re-save that leaves a key field blank
 * must PRESERVE the stored key instead of wiping it. Rules, per category:
 *
 *   - provider blank / 'none'        → clear the whole category (provider + key).
 *   - provider set + key present     → write the new provider + key.
 *   - provider set + key blank       → keep the stored key when the provider is
 *                                      unchanged; otherwise error (a newly
 *                                      selected provider needs its own key).
 *   - optional SECRET fields (e.g. Stripe webhook secret) are preserved when
 *     blank.
 *   - optional NON-SECRET fields (e.g. stripe_price_id, which IS echoed back)
 *     are cleared when blank.
 *
 * `existing` is the currently persisted row (may be null on a fresh store).
 */
export function normalizePlatformSettingsPatch(
  raw: Record<string, unknown>,
  existing: GlobalPlatformSettings | null,
): { ok: true; input: PlatformSettingsInput } | { ok: false; error: string } {
  // ── Email (optional) ────────────────────────────────────────────────────────
  const mailRaw = String(raw.mail_provider ?? '').trim();
  const isMailSkip = !mailRaw || mailRaw.toLowerCase() === 'none';
  const mailProvider = isMailSkip ? null : sanitizeMailProvider(raw.mail_provider);
  if (!isMailSkip && !mailProvider) return { ok: false, error: 'Choose a valid email provider.' };
  const mailApiKeyRaw = String(raw.mail_api_key ?? '').trim();
  let mailApiKey: string | null;
  if (!mailProvider) {
    mailApiKey = null;
  } else if (mailApiKeyRaw) {
    mailApiKey = mailApiKeyRaw;
  } else if (existing?.mail_provider === mailProvider && existing.mail_api_key) {
    mailApiKey = existing.mail_api_key;
  } else {
    return { ok: false, error: 'Enter an email provider API key.' };
  }

  // ── Payments (optional) ─────────────────────────────────────────────────────
  const paymentRaw = String(raw.payment_provider ?? '').trim();
  const isPaymentSkip = !paymentRaw || paymentRaw.toLowerCase() === 'none';
  const paymentProvider = isPaymentSkip ? null : sanitizePaymentProvider(raw.payment_provider);
  if (!isPaymentSkip && !paymentProvider) return { ok: false, error: 'Choose a valid payment provider.' };
  const paymentApiKeyRaw = String(raw.payment_api_key ?? '').trim();
  let paymentApiKey: string | null;
  if (!paymentProvider) {
    paymentApiKey = null;
  } else if (paymentApiKeyRaw) {
    paymentApiKey = paymentApiKeyRaw;
  } else if (existing?.payment_provider === paymentProvider && existing.payment_api_key) {
    paymentApiKey = existing.payment_api_key;
  } else {
    return { ok: false, error: 'Enter a payment provider API key.' };
  }

  // Webhook secret is write-only → blank keeps the stored value.
  const paymentWebhookSecretRaw = String(raw.payment_webhook_secret ?? '').trim();
  const paymentWebhookSecret =
    paymentProvider === 'stripe'
      ? paymentWebhookSecretRaw || existing?.payment_webhook_secret || undefined
      : undefined;

  // stripe_price_id is NOT a secret (it is echoed back to the UI) → blank clears it.
  const stripePriceIdRaw = String(raw.stripe_price_id ?? '').trim();
  const stripePriceId = paymentProvider === 'stripe' && stripePriceIdRaw ? stripePriceIdRaw : undefined;

  // ── Maps (optional) ─────────────────────────────────────────────────────────
  const mapRaw = String(raw.map_provider ?? '').trim();
  const isMapSkip = !mapRaw || mapRaw.toLowerCase() === 'none';
  const mapProvider = isMapSkip ? null : sanitizeMapProvider(raw.map_provider);
  if (!isMapSkip && !mapProvider) return { ok: false, error: 'Choose a valid map provider.' };
  const mapApiKeyRaw = String(raw.map_api_key ?? '').trim();
  let mapApiKey: string | undefined;
  if (!mapProvider || mapProvider === 'open_street_map') {
    mapApiKey = undefined;
  } else if (mapApiKeyRaw) {
    mapApiKey = mapApiKeyRaw;
  } else if (existing?.map_provider === mapProvider && existing.map_api_key) {
    mapApiKey = existing.map_api_key;
  } else {
    return { ok: false, error: 'Enter a map provider API key.' };
  }

  // ── AI primary (optional) ───────────────────────────────────────────────────
  const aiRaw = String(raw.ai_provider ?? '').trim();
  const isAiSkip = !aiRaw || aiRaw.toLowerCase() === 'none';
  const aiProvider = isAiSkip ? null : sanitizeAiProvider(raw.ai_provider);
  if (!isAiSkip && !aiProvider) return { ok: false, error: 'Choose a valid AI provider.' };
  const aiApiKeyRaw = String(raw.ai_api_key ?? '').trim();
  let aiApiKey: string | null;
  if (!aiProvider) {
    aiApiKey = null;
  } else if (aiProvider === 'workers_ai') {
    aiApiKey = null;
  } else if (aiApiKeyRaw) {
    aiApiKey = aiApiKeyRaw;
  } else if (existing?.ai_provider === aiProvider && existing.ai_api_key) {
    aiApiKey = existing.ai_api_key;
  } else {
    return { ok: false, error: 'Enter an AI provider API key (Workers AI needs none).' };
  }

  // ── AI secondary (optional fallback) ────────────────────────────────────────
  const aiSecondaryRaw = String(raw.ai_provider_secondary ?? '').trim();
  const aiProviderSecondary =
    !aiSecondaryRaw || aiSecondaryRaw.toLowerCase() === 'none'
      ? null
      : sanitizeAiProvider(raw.ai_provider_secondary);
  const aiApiKeySecondaryRaw = String(raw.ai_api_key_secondary ?? '').trim();
  let aiApiKeySecondary: string | undefined;
  if (!aiProviderSecondary) {
    aiApiKeySecondary = undefined;
  } else if (aiProviderSecondary === 'workers_ai') {
    aiApiKeySecondary = undefined;
  } else if (aiApiKeySecondaryRaw) {
    aiApiKeySecondary = aiApiKeySecondaryRaw;
  } else if (
    isDeepSeekProvider(aiProviderSecondary) &&
    isDeepSeekProvider(aiProvider) &&
    Boolean(aiApiKey)
  ) {
    // DeepSeek Pro/Lite share ONE key — the factories reuse the primary key, so
    // the secondary column stays empty (mirrors normalizePlatformSettingsInput).
    aiApiKeySecondary = undefined;
  } else if (existing?.ai_provider_secondary === aiProviderSecondary && existing.ai_api_key_secondary) {
    aiApiKeySecondary = existing.ai_api_key_secondary;
  } else {
    return {
      ok: false,
      error: 'Enter a secondary AI provider API key (Workers AI needs none), or clear the secondary provider.',
    };
  }

  // ── 3D asset / image-to-3D engine (optional) ────────────────────────────────
  const ai3dRaw = String(raw.ai3d_provider ?? '').trim();
  const isAi3dSkip = !ai3dRaw || ai3dRaw.toLowerCase() === 'none';
  const ai3dProvider = isAi3dSkip ? null : sanitizeAi3dProvider(raw.ai3d_provider);
  if (!isAi3dSkip && !ai3dProvider) return { ok: false, error: 'Choose a valid 3D asset provider.' };
  const ai3dKeyRaw = String(raw.ai3d_key ?? '').trim();
  let ai3dKey: string | undefined;
  if (!ai3dProvider) {
    ai3dKey = undefined;
  } else if (ai3dKeyRaw) {
    ai3dKey = ai3dKeyRaw;
  } else if (existing?.ai3d_provider === ai3dProvider && existing.ai3d_key) {
    ai3dKey = existing.ai3d_key;
  } else {
    return { ok: false, error: 'Enter a 3D asset provider API key.' };
  }
  // ai3d_endpoint is NOT a secret (it is echoed back) → blank clears it.
  const ai3dEndpoint = ai3dProvider && String(raw.ai3d_endpoint ?? '').trim() ? String(raw.ai3d_endpoint ?? '').trim() : undefined;
  // ai_model is NOT a secret → blank clears it.
  const aiModel = String(raw.ai_model ?? '').trim() || undefined;
  // ai3d_model is NOT a secret → blank clears it.
  const ai3dModel = String(raw.ai3d_model ?? '').trim() || undefined;

  return {
    ok: true,
    input: {
      mail_provider: mailProvider,
      mail_api_key: mailApiKey,
      payment_provider: paymentProvider,
      payment_api_key: paymentApiKey,
      payment_webhook_secret: paymentWebhookSecret,
      stripe_price_id: stripePriceId,
      map_provider: mapProvider,
      map_api_key: mapApiKey,
      ai_provider: aiProvider,
      ai_api_key: aiApiKey,
      ai_provider_secondary: aiProviderSecondary,
      ai_api_key_secondary: aiApiKeySecondary,
      ai_model: aiModel,
      ai3d_provider: ai3dProvider,
      ai3d_key: ai3dKey,
      ai3d_endpoint: ai3dEndpoint,
      ai3d_model: ai3dModel,
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
    ai_model: input.ai_model || null,
    ai3d_provider: input.ai3d_provider || null,
    ai3d_key: input.ai3d_key || null,
    ai3d_endpoint: input.ai3d_endpoint || null,
    ai3d_model: input.ai3d_model || null,
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

/**
 * Resolve the effective Supabase personal access token for one-click schema
 * builds. Priority: inline runtime override → `SUPABASE_ACCESS_TOKEN` env → the
 * token PERSISTED in `operational_settings` (so a serverless cold start still
 * has it after the operator saved it once — the token is no longer discarded
 * after the first wizard run).
 */
export async function resolveSupabaseAccessToken(): Promise<string> {
  const inline = readSupabaseAccessToken().trim();
  if (inline) return inline;
  const settings = await getPlatformSettings().catch(() => null);
  return String(settings?.operational_settings?.supabase_access_token || '').trim();
}

/**
 * Persist the Supabase personal access token into the RLS-protected
 * `operational_settings` JSONB (service-role-only write; never returned to the
 * browser). This lets the background schema self-heal reuse the token across
 * restarts instead of demanding the operator re-enter it. Merges with any
 * existing operational settings so nothing else is lost.
 */
export async function persistSupabaseAccessToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) return;
  const existing = await getPlatformSettings({ force: true }).catch(() => null);
  const operational: OperationalSettings = {
    ...(existing?.operational_settings || {}),
    supabase_access_token: trimmed,
  };
  await saveOperationalSettings(operational);
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
