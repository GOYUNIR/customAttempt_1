import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { startPlanCheckout } from '@/lib/plan-billing';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Start paying for the self-serve plan (Growth) for THIS store: a Stripe
 * Checkout subscription on the platform account. Owner only. The plan changes
 * only when Stripe says the subscription is active (the platform webhook).
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can change the plan.' }, 403);
  const limited = await rateLimitedResponse('merchant_billing', request, 10, 60);
  if (limited) return limited;
  const r = await startPlanCheckout({ tenantId: gate.session.tenantId, ownerEmail: gate.session.email });
  if (!r.ok) return merchantJson({ error: r.error }, r.status);
  await auditMerchant(gate.session, request, 'PLAN_CHECKOUT_STARTED', 'switch to the paid plan');
  return merchantJson({ url: r.url });
}
