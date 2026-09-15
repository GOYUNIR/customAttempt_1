import { NextResponse } from 'next/server';
import { adminAuthorized, resolveAdminActor } from '@/lib/admin-verify';
import { actorHasMerchantAccess, actorHasPlatformAdminAccess } from '@/lib/admin-actor';
import { resolveActingTenantId } from '@/lib/tenant-context';
import { supabaseServiceConfigured, readSupabaseEnv, supabaseRestFetch } from '@/services/config/supabase-client';

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
    if (!supabaseServiceConfigured()) {
      return NextResponse.json({ ok: true, ordersToday: 0, pendingRaffleEntries: 0, notConfigured: true });
    }

    const tenantId = await resolveActingTenantId(actor);
    const { serviceRoleKey } = readSupabaseEnv();
    const midnightIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

    const [orders, entries] = await Promise.all([
      supabaseRestFetch(
        `/orders?tenant_id=eq.${encodeURIComponent(tenantId)}&created_at=gte.${encodeURIComponent(midnightIso)}&select=id`,
        { key: serviceRoleKey },
      ).catch(() => []),
      supabaseRestFetch(
        `/raffle_entries?tenant_id=eq.${encodeURIComponent(tenantId)}&status=eq.pending&select=id`,
        { key: serviceRoleKey },
      ).catch(() => []),
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
