import { NextResponse } from 'next/server';
import { createKvClient, safeParseKvItem, AUDIT_LOG_KEY} from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { recordPlatformAudit } from '@/lib/platform-audit';
import { clientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Every existing call site of this function (14 across the highest-risk
 * admin/account write routes: wipe, users, products, promos, orders, …)
 * automatically gets a REAL, immutable audit trail entry — see
 * lib/platform-audit.ts — with zero per-route changes. The bounded 200-entry
 * Redis list below is kept as-is for the admin UI's fast "recent activity"
 * view (and is explicitly NOT tamper-resistant — `wipe` erases it along with
 * everything else); the Supabase write is the tamper-resistant one.
 *
 * `request`/`staffId`/`tenantId` are optional additions for the enterprise
 * audit shape (ip_address/staff_id/target_tenant_id) — every existing call
 * site keeps working unchanged without them.
 */
export async function appendAudit(
  redis: any,
  entry: { action: string; detail?: string; actor?: string; email?: string; staffId?: string | null; tenantId?: string | null },
  request?: Request,
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
  // Awaited (not fire-and-forget): several deploy targets (serverless
  // functions, Workers) can freeze/terminate the runtime the instant the
  // response is sent, which would silently drop an un-awaited write. It
  // never throws internally, so this adds latency but never failure.
  await recordPlatformAudit({
    action: entry.action,
    actor: entry.email || entry.actor || 'admin',
    detail: entry.detail ? { detail: entry.detail } : {},
    staffId: entry.staffId ?? null,
    tenantId: entry.tenantId ?? null,
    ipAddress: request ? clientIp(request) : null,
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }
  const redis = createKvClient();
  if (!redis) return NextResponse.json({ entries: [] });
  const rows = await redis.lrange(AUDIT_LOG_KEY, -100, -1);
  const entries = rows.map((r) => safeParseKvItem(r)).filter(Boolean).reverse();
  return NextResponse.json({ entries });
}