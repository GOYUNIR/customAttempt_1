import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { getLicenseStatus, isWriteAllowed } from '@/lib/license';
import { AiFactory } from '@/services/ai';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { recordUsageEvent } from '@/lib/analytics-events';

export const dynamic = 'force-dynamic';

async function authorized(request: Request): Promise<boolean> {
  if (adminRequestAuthorized(request)) return true;
  return isSuperAdminSession(request);
}

/**
 * POST /api/ai/generate — generic text generation through the active AI driver
 * (copy, tags, product descriptions). Admin-only + license-gated; returns a
 * neutral error when no provider is configured.
 */
export async function POST(request: Request) {
  const limited = await rateLimitedResponse('ai_generate', request, 30, 60);
  if (limited) return limited;

  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const license = await getLicenseStatus();
  if (!isWriteAllowed(license.status)) {
    return NextResponse.json(
      { error: 'Demo Mode: AI generation is disabled until a license is active.', license: license.status },
      { status: 403 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const prompt = String(body.prompt || '').trim().slice(0, 4000);
  if (!prompt) return NextResponse.json({ error: 'Enter a prompt.' }, { status: 400 });

  const driver = await AiFactory.getDriver();
  if (!driver?.configured) {
    return NextResponse.json(
      { error: 'No AI provider is configured. Set an AI provider in /admin → Setup (or an env key like DEEPSEEK_API_KEY).' },
      { status: 400 },
    );
  }

  const completion = await driver.complete(prompt);

  // H8: usage metrics land in public.analytics_events, not the
  // analytics:usage KV counter. Best-effort, exactly as before — a metrics
  // write must never fail the generation the caller is waiting on.
  await recordUsageEvent({ metric: 'ai_generations' }).catch(() => {});

  if (!completion.ok) {
    return NextResponse.json({ error: 'The AI provider failed to generate a response.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, text: completion.text, provider: completion.provider });
}
