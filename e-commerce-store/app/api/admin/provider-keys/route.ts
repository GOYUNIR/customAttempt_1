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
  normalizePlatformSettingsInput,
} from '@/services/config/platform-settings';
import { toPublicSummary } from '@/services/config/types';

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

  const normalized = normalizePlatformSettingsInput(body);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }

  // Provider keys (payments / email / maps / AI) — exactly what the wizard's
  // optional-providers card persists, minus the super-admin account + the
  // is_configured gate. Operational settings (storage provider, cron secret,
  // admin passwords…) are intentionally left untouched here so this route can
  // never accidentally wipe them.
  await savePlatformSettings(normalized.input);

  const settings = await getPlatformSettings({ force: true }).catch(() => null);
  return NextResponse.json({ ok: true, summary: toPublicSummary(settings) });
}
