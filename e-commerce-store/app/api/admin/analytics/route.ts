import { NextResponse } from 'next/server';
import { adminRequestAuthorized } from '@/lib/server-config';
import { isSuperAdminSession } from '@/lib/admin-verify';
import { USAGE_METRICS } from '@/lib/analytics';
import { readUsageTotalsFromDb } from '@/lib/analytics-events';
import { getDb } from '@/lib/db/client';

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

  // H8: totals come from public.analytics_events. `tenant` may still arrive as
  // the legacy literal 'default' from an older client; resolveTenantUuid inside
  // the reader turns anything that is not a uuid into the default tenant.
  if (!getDb().configured) {
    return NextResponse.json({ ok: true, tenant, days, totals: { api_calls: 0, ai_generations: 0, system_events: 0 }, metrics: USAGE_METRICS });
  }

  const totals = await readUsageTotalsFromDb({ tenantId: tenant, days });
  return NextResponse.json({ ok: true, tenant, days, totals, metrics: USAGE_METRICS });
}
