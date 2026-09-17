import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { getLicenseStatus, isWriteAllowed } from '@/lib/license';
import { AiFactory } from '@/services/ai';
import {
  buildAnimationPrompt,
  parseAnimationResult,
  fallbackAnimation,
  FALLBACK_ANIMATION_PRESETS,
  type AnimationResult,
} from '@/lib/ai-animation';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { recordUsageEvent } from '@/lib/analytics-events';

export const dynamic = 'force-dynamic';

/** Admin-only gate: env Basic Auth OR a super-admin device session. */
async function authorized(request: Request): Promise<boolean> {
  if (adminRequestAuthorized(request)) return true;
  return isSuperAdminSession(request);
}

/**
 * GET /api/ai/animation — provider status (name only, never the key) + the
 * built-in fallback presets for the admin animation studio.
 */
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const driver = await AiFactory.getDriver();
  const license = await getLicenseStatus();
  return NextResponse.json({
    ok: true,
    provider: driver?.configured ? driver.provider : null,
    configured: Boolean(driver?.configured),
    presets: FALLBACK_ANIMATION_PRESETS,
    license: { status: license.status, writesAllowed: license.writesAllowed },
  });
}

/**
 * POST /api/ai/animation — image-to-animation + dynamic SVG generation.
 * Passes the uploaded product asset ref + prompt to the active AI provider and
 * returns CSS keyframes / animated SVG. Falls back to a CSS/SVG preset when no
 * provider is configured or the call fails.
 */
export async function POST(request: Request) {
  const limited = await rateLimitedResponse('ai_animation', request, 30, 60);
  if (limited) return limited;

  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const license = await getLicenseStatus();
  if (!isWriteAllowed(license.status)) {
    return NextResponse.json(
      { error: 'Demo Mode: asset generation is disabled until a license is active.', license: license.status },
      { status: 403 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const assetRef = String(body.assetRef || '').slice(0, 512);
  const prompt = String(body.prompt || '').slice(0, 2000);
  const preset = String(body.preset || '');

  let result: AnimationResult;
  const driver = await AiFactory.getDriver();
  if (driver?.configured) {
    const completion = await driver.complete(buildAnimationPrompt({ assetRef, prompt }));
    result = completion.ok ? parseAnimationResult(completion.text, driver.provider) ?? fallbackAnimation(preset) : fallbackAnimation(preset);
  } else {
    result = fallbackAnimation(preset);
  }

  // H8: usage metrics land in public.analytics_events, not the
  // analytics:usage KV counter. Best-effort, exactly as before — a metrics
  // write must never fail the generation the caller is waiting on.
  await recordUsageEvent({ metric: 'ai_generations' }).catch(() => {});

  return NextResponse.json({ ok: true, result });
}
