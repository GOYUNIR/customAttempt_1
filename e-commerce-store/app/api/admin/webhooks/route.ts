import { NextResponse } from 'next/server';
import { adminRequestAuthorized, createRedisClient } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { safeParseRedisItem } from '@/lib/server-config';
import { WEBHOOK_CONFIG_KEY, WEBHOOK_QUEUE_KEY } from '@/lib/redis-keys';
import { flushWebhookQueue, WEBHOOK_EVENTS } from '@/lib/webhooks';

export const dynamic = 'force-dynamic';

async function authorized(request: Request): Promise<boolean> {
  if (adminRequestAuthorized(request)) return true;
  return isSuperAdminSession(request);
}

/** Parse the stored subscribers map (event → URL). */
function parseSubscribers(raw: unknown): Record<string, string> {
  const parsed = safeParseRedisItem<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, string> = {};
  for (const event of WEBHOOK_EVENTS) {
    const value = parsed[event];
    if (typeof value === 'string' && value.trim()) out[event] = value.trim();
  }
  return out;
}

/**
 * GET /api/admin/webhooks — current subscribers + queue depth.
 * POST — `{ action: 'flush' }` to deliver queued jobs, or
 *        `{ action: 'save', subscribers: { event: url } }` to persist config.
 */
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const storage = createRedisClient();
  const subscribers = storage ? parseSubscribers(await storage.get(WEBHOOK_CONFIG_KEY)) : {};
  const queueLength = storage ? await storage.llen(WEBHOOK_QUEUE_KEY) : 0;
  return NextResponse.json({ ok: true, events: WEBHOOK_EVENTS, subscribers, queueLength });
}

export async function POST(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const storage = createRedisClient();
  if (!storage) {
    return NextResponse.json({ error: 'No data store configured.' }, { status: 500 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const action = String(body.action || '');
  if (action === 'flush') {
    const subscribers = parseSubscribers(await storage.get(WEBHOOK_CONFIG_KEY));
    const result = await flushWebhookQueue({ storage, queueKey: WEBHOOK_QUEUE_KEY, subscribers });
    return NextResponse.json({ ok: true, ...result });
  }

  if (action === 'save') {
    const rawSubscribers = (body.subscribers || {}) as Record<string, unknown>;
    const subscribers = parseSubscribers(rawSubscribers);
    await storage.set(WEBHOOK_CONFIG_KEY, JSON.stringify(subscribers));
    return NextResponse.json({ ok: true, subscribers });
  }

  return NextResponse.json({ error: 'Unknown action (use "flush" or "save").' }, { status: 400 });
}
