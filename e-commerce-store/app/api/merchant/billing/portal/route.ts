import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { planPortal } from '@/lib/plan-billing';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Stripe's billing portal for THIS store (cancel, card, invoices). Owner only. */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can manage billing.' }, 403);
  const limited = await rateLimitedResponse('merchant_billing', request, 10, 60);
  if (limited) return limited;
  const r = await planPortal(gate.session.tenantId);
  return r.ok ? merchantJson({ url: r.url }) : merchantJson({ error: r.error }, r.status);
}
