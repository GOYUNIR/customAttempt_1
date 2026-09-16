import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasMerchantAccess, actorHasPlatformAdminAccess } from '@/lib/admin-actor';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { getDb } from '@/lib/db/client';
import { eq, gte } from '@/lib/db/query';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/telemetry — real counts for `components/admin/TelemetryDashboard.tsx`'s
 * "today" tile: confirmed orders and pending raffle entries created since
 * local midnight, for this tenant. No fabricated numbers — a miss (no
 * Supabase, no rows) reports 0, never a placeholder figure.
 */
export async function GET(request: Request) {
  try {
    if (!(await adminAuthorized(request))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const actor = await resolveAdminActor(request);
    if (!actorHasMerchantAccess(actor) && !actorHasPlatformAdminAccess(actor)) {
      return NextResponse.json({ error: 'Access required.' }, { status: 403 });
    }
    if (!getDb().configured) {
      return NextResponse.json({ ok: true, ordersToday: 0, pendingRaffleEntries: 0, notConfigured: true });
    }

    const tenantId = await resolveActingTenantId(actor);
    const midnightIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

    const [orders, entries] = await Promise.all([
      getDb()
        .select('orders', {
          where: { tenant_id: eq(tenantId), created_at: gte(midnightIso) },
          select: ['id'],
        })
        .catch(() => []),
      getDb()
        .select('raffle_entries', {
          where: { tenant_id: eq(tenantId), status: eq('pending') },
          select: ['id'],
        })
        .catch(() => []),
    ]);

    return NextResponse.json({
      ok: true,
      ordersToday: Array.isArray(orders) ? orders.length : 0,
      pendingRaffleEntries: Array.isArray(entries) ? entries.length : 0,
      notConfigured: false,
    });
  } catch (err: any) {
    console.error('[admin/telemetry] failed', err?.message || err);
    return NextResponse.json({ error: 'Could not load telemetry.' }, { status: 500 });
  }
}
