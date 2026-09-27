import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { planState } from '@/lib/plan-billing';

export const dynamic = 'force-dynamic';

/** THIS store's plan and billing state. Owner only: billing is the owner's. */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can see billing.' }, 403);
  return merchantJson(await planState(gate.session.tenantId));
}
