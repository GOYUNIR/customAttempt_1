import { NextResponse } from 'next/server';
import { createRedisClient, adminRequestAuthorized } from '@/lib/server-config';
import {
  adminLoginAuthorized,
  isSuperAdminSession,
  isAdminDeviceValid,
  adminDeviceTokenFromRequest,
} from '@/lib/admin-verify';
import {
  getPlatformSettings,
  savePlatformSettings,
  normalizePlatformSettingsPatch,
} from '@/services/config/platform-settings';
import { toPublicSummary, type PlatformSettingsInput } from '@/services/config/types';
import { setSupabaseRuntimeAccessToken } from '@/services/config/supabase-client';
import { isSchemaError, buildSchemaFixPlan } from '@/lib/setup-schema-guide';
import { autoApplySchema, supabaseAutoMigrateAvailable } from '@/lib/supabase-migrate';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/provider-keys — the portal's "Provider keys & APIs" surface.
 *
 * Mirrors the Setup Wizard's optional-providers card (payments / transactional
 * email / maps / AI) but WITHOUT the bootstrap ceremony: the caller is already
 * signed in, so this route only needs the same admin auth the rest of the
 * portal uses. Keys are written to `global_platform_settings` and never echoed
 * back — only the provider names are returned via `toPublicSummary`.
 */

async function authorized(request: Request, password: string): Promise<boolean> {
  if (adminRequestAuthorized(request, password)) return true;
  if (await adminLoginAuthorized(request, password)) return true;
  if (await isSuperAdminSession(request)) return true;
  const redis = createRedisClient();
  const token = adminDeviceTokenFromRequest(request);
  if (redis && token) {
    return await isAdminDeviceValid(redis, token).catch(() => false);
  }
  return false;
}

export async function GET() {
  const settings = await getPlatformSettings({ force: true }).catch(() => null);
  return NextResponse.json({ ok: true, summary: toPublicSummary(settings) });
}

/**
 * Save the settings row, transparently applying a missing Supabase schema when a
 * management access token is available. This mirrors the Setup Wizard's
 * self-heal: `stripe_price_id` (00005) / `ai_api_key_secondary` (00004) may be
 * absent on an older database, which PostgREST reports as a schema error.
 *
 * `token` is the optional inline Supabase personal access token supplied by the
 * admin panel — so the store can build its own schema on save even when the
 * operator never set `SUPABASE_ACCESS_TOKEN` as an environment variable.
 */
async function saveWithSchemaHeal(input: PlatformSettingsInput, token?: string): Promise<void> {
  try {
    await savePlatformSettings(input);
    return;
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (isSchemaError(message) && supabaseAutoMigrateAvailable(token)) {
      const result = await autoApplySchema(token);
      if (result.applied) {
        await savePlatformSettings(input);
        return;
      }
      // The heal was possible but failed (e.g. an expired/rejected token) —
      // surface the real reason instead of the original schema gap.
      throw new Error(result.error || message);
    }
    throw err;
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const password = String(body?.password || '');
  if (!(await authorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Optional inline Supabase personal access token — lets the save self-heal a
  // missing schema via the Management API even when the operator hasn't set
  // SUPABASE_ACCESS_TOKEN as an environment variable. Never echoed back.
  const supabaseAccessToken = String(body.supabase_access_token || body.supabaseAccessToken || '').trim();
  if (supabaseAccessToken) setSupabaseRuntimeAccessToken(supabaseAccessToken);

  // The currently persisted row is used to PRESERVE write-only keys that the
  // operator leaves blank (they are never echoed back to the UI). A read failure
  // is non-fatal: the patch then simply requires a key for every selected
  // provider, which is the safe behavior for a store that can't be read.
  //
  // BUT a read can also fail simply because the schema was never applied. Heal
  // that FIRST (before normalization) so the existing row's write-only keys are
  // available to merge — otherwise a partial re-save would demand every key
  // again (e.g. "Enter an AI provider API key") even though they are stored.
  let existing = null as Awaited<ReturnType<typeof getPlatformSettings>>;
  try {
    existing = await getPlatformSettings({ force: true });
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    if (isSchemaError(message) && supabaseAutoMigrateAvailable(supabaseAccessToken || undefined)) {
      const healed = await autoApplySchema(supabaseAccessToken || undefined);
      if (healed.applied) {
        existing = await getPlatformSettings({ force: true }).catch(() => null);
      }
    }
  }

  const normalized = normalizePlatformSettingsPatch(body, existing);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }

  // Provider keys (payments / email / maps / AI) — exactly what the wizard's
  // optional-providers card persists, minus the super-admin account + the
  // is_configured gate. Operational settings (storage provider, cron secret,
  // admin passwords…) are intentionally left untouched here so this route can
  // never accidentally wipe them.
  try {
    await saveWithSchemaHeal(normalized.input, supabaseAccessToken || undefined);
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    console.error('[provider-keys] save failed', message);
    const schemaMissing = isSchemaError(message);
    const plan = schemaMissing ? buildSchemaFixPlan(message) : null;
    const canSelfHeal = supabaseAutoMigrateAvailable(supabaseAccessToken || undefined);
    return NextResponse.json(
      {
        ok: false,
        error: plan
          ? 'Your Supabase database is missing part of its schema. Add your Supabase access token below so the store can build it automatically, or run `supabase db push` and retry.'
          : message,
        schemaMissing,
        schemaError: plan,
        needsAccessToken: schemaMissing && !canSelfHeal,
      },
      { status: schemaMissing ? 400 : 500 },
    );
  }

  const settings = await getPlatformSettings({ force: true }).catch(() => null);
  return NextResponse.json({ ok: true, summary: toPublicSummary(settings) });
}
