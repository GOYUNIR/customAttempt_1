import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { runTenantDueDrops } from '@/lib/tenant-drops';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * "Run due draws now" for THIS store: only work that is due runs (draws whose
 * date has passed, winners still to charge, waitlists of items on sale), each
 * draw and each charge once, within this request's call budget. `more` means
 * press again (or let the countdown and the scheduler carry on).
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_drops_run', request, 10, 60);
  if (limited) return limited;
  const r = await runTenantDueDrops(gate.session.tenantId, gate.session.tenantSlug);
  const all = [...r.draws, ...r.waitlist];
  await auditMerchant(gate.session, request, 'DROPS_RUN', r.draws.filter((d: any) => d.drawId).length + ' draw(s), ' + all.filter((d: any) => d.status === 'charged').length + ' charged');
  return merchantJson({
    skipped: r.skipped || null,
    draws: r.draws.filter((d: any) => d.drawId).length,
    charged: all.filter((d: any) => d.status === 'charged').length,
    declined: all.filter((d: any) => d.status === 'declined').length,
    more: r.more,
  });
}
