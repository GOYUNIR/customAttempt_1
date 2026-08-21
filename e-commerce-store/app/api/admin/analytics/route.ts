import { NextResponse } from 'next/server';
import { adminRequestAuthorized, createRedisClient } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { readUsageTotals, USAGE_METRICS } from '@/lib/analytics';
import { ANALYTICS_USAGE_PREFIX } from '@/lib/redis-keys';

export const dynamic = 'force-dynamic';

async function authorized(request: Request): Promise<boolean> {
  if (adminRequestAuthorized(request)) return true;
  return isSuperAdminSession(request);
}

/**
 * GET /api/admin/analytics — per-tenant usage metrics (daily API calls, AI
 * asset generations, system events) over a rolling window. Supports
 * `?tenant=<id>&days=<n>`.
 */
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const tenant = url.searchParams.get('tenant') || 'default';
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));

  const storage = createRedisClient();
  if (!storage) {
    return NextResponse.json({ ok: true, tenant, days, totals: { api_calls: 0, ai_generations: 0, system_events: 0 }, metrics: USAGE_METRICS });
  }

  const totals = await readUsageTotals(storage, { prefix: ANALYTICS_USAGE_PREFIX, tenantId: tenant, days });
  return NextResponse.json({ ok: true, tenant, days, totals, metrics: USAGE_METRICS });
}
