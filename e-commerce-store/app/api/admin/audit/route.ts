import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem , getAdminPassword} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export const AUDIT_KEY = 'admin:audit_log';

export async function appendAudit(
  redis: any,
  entry: { action: string; detail?: string; actor?: string; email?: string },
) {
  try {
    await redis.rpush(
      AUDIT_KEY,
      JSON.stringify({
        action: entry.action,
        detail: entry.detail,
        actor: entry.actor || 'admin',
        ...(entry.email ? { email: entry.email } : {}),
        at: new Date().toISOString(),
      }),
    );
    // keep last 200
    const len = await redis.llen(AUDIT_KEY);
    if (len > 200) await redis.ltrim(AUDIT_KEY, len - 200, -1);
  } catch {}
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (password !== getAdminPassword()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ entries: [] });
  const rows = await redis.lrange(AUDIT_KEY, -100, -1);
  const entries = rows.map((r) => safeParseRedisItem(r)).filter(Boolean).reverse();
  return NextResponse.json({ entries });
}