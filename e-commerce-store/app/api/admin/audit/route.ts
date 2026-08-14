import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, adminRequestAuthorized, AUDIT_LOG_KEY} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function appendAudit(
  redis: any,
  entry: { action: string; detail?: string; actor?: string; email?: string },
) {
  try {
    await redis.rpush(
      AUDIT_LOG_KEY,
      JSON.stringify({
        action: entry.action,
        detail: entry.detail,
        actor: entry.actor || 'admin',
        ...(entry.email ? { email: entry.email } : {}),
        at: new Date().toISOString(),
      }),
    );
    // keep last 200
    const len = await redis.llen(AUDIT_LOG_KEY);
    if (len > 200) await redis.ltrim(AUDIT_LOG_KEY, len - 200, -1);
  } catch {}
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!adminRequestAuthorized(request, password)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ entries: [] });
  const rows = await redis.lrange(AUDIT_LOG_KEY, -100, -1);
  const entries = rows.map((r) => safeParseRedisItem(r)).filter(Boolean).reverse();
  return NextResponse.json({ entries });
}