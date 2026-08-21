import { NextResponse } from 'next/server';
import { getAdminPassword, adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { supabaseEnvSummary } from '@/services/config/edge';
import { getPlatformSettings, isPlatformConfigured } from '@/services/config/platform-settings';
import { toPublicSummary } from '@/services/config/types';
import {
  discoverEnvironment,
  computeAdminReady,
  detectStorageDrivers,
  detectStorageProvider,
  CLOUDFLARE_VARS_PATH,
} from '@/lib/env-discovery';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/setup-status — the System Configuration & Setup Checklist backend.
 *
 * Returns ONLY presence booleans + names + copyable setup commands (never any
 * secret VALUES) so the /admin/setup-status page can render the ✅/❌ breakdown
 * and — critically — so it works BEFORE any credentials exist (the whole point
 * of the checklist is to guide a fresh install that has nothing configured yet).
 *
 * Once the store IS ready, the response is gated behind admin auth as
 * defense-in-depth (the middleware also gates it). Pre-config it is open so the
 * checklist can render, matching the /api/admin/setup wizard's pre-config
 * behavior.
 */
export async function GET(request: Request) {
  const discovery = discoverEnvironment();
  const storageDrivers = detectStorageDrivers();
  const legacyAdminOk = Boolean(getAdminPassword());
  const platformConfigured = (await isPlatformConfigured()) === true;
  const ready = computeAdminReady({ storage: storageDrivers, legacyAdminOk, platformConfigured });
  const storageOk =
    storageDrivers.supabase || storageDrivers.cloudflare || storageDrivers.redis || platformConfigured;

  if (ready) {
    const authorized = adminRequestAuthorized(request) || (await isSuperAdminSession(request));
    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
  }

  const platformProviders = toPublicSummary(await getPlatformSettings());

  return NextResponse.json({
    ok: true,
    ready,
    storageProvider: detectStorageProvider(),
    storageDrivers,
    storageOk,
    legacyAdminOk,
    platformConfigured,
    platformProviders,
    supabase: supabaseEnvSummary(),
    environment: process.env.NODE_ENV || 'development',
    cloudflareVarsPath: CLOUDFLARE_VARS_PATH,
    discovery,
  });
}
