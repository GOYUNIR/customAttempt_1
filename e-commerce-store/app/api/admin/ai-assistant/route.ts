import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { runAssistantTurn } from '@/lib/ai-assistant/runner';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { appendAudit } from '@/app/api/admin/audit/route';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/ai-assistant — the guardrailed AI co-pilot (Phase 5).
 * See lib/ai-assistant/runner.ts's header for the full design: tool
 * visibility is filtered by the CALLER'S OWN resolved role/tenant before
 * anything is sent to the model, so neither the user's message nor the
 * model's own output can widen what gets executed or which tenant it acts
 * on.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimitedResponse('admin_ai_assistant', request, 15, 60);
    if (limited) return limited;

    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    const message = String(body?.message || '').trim();
    if (!message) {
      return NextResponse.json({ error: 'message is required.' }, { status: 400 });
    }

    const actor = await resolveAdminActor(request);
    if (!actor) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const tenantId = await resolveActingTenantId(actor);

    const result = await runAssistantTurn(message, { role: actor.role, impersonating: actor.impersonating }, tenantId, actor.email);

    if (result.toolCalled && result.ok) {
      const redis = createRedisClient();
      if (redis) {
        await appendAudit(
          redis,
          {
            action: 'AI_ASSISTANT_TOOL_EXECUTED',
            detail: `${result.toolCalled} — ${JSON.stringify(result.toolResult).slice(0, 500)}`,
            actor: actor.email || 'admin',
            tenantId,
          },
          request,
        );
      }
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'The assistant could not complete that request.' }, { status: 422 });
    }
    return NextResponse.json({ ok: true, reply: result.reply, toolCalled: result.toolCalled, toolResult: result.toolResult });
  } catch (err: any) {
    console.error('[ai-assistant] failed', err?.message || err);
    return NextResponse.json({ error: 'The assistant is unavailable right now.' }, { status: 500 });
  }
}
