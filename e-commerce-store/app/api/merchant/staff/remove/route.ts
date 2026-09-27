import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { removeTenantStaff } from '@/lib/staff-accounts';

export const dynamic = 'force-dynamic';

/**
 * Remove a STAFF member from THIS store (owner only). Only a role-'staff' row
 * of the session's store can match, so an owner, the caller, or another
 * store's person is untouched. Their open sessions stop at once: the gate
 * re-checks membership in the database on every call.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can manage staff.' }, 403);
  const body = await request.json().catch(() => ({}));
  const email = String(body?.email || '').trim().toLowerCase();
  if (!email || email === gate.session.email) return merchantJson({ error: 'Choose a staff member to remove.' }, 400);
  const result = await removeTenantStaff(email, gate.session.tenantId);
  if (result === 'not_found') return merchantJson({ error: 'That person is not staff of your store.' }, 404);
  if (result === 'error') return merchantJson({ error: 'That person could not be removed. Try again.' }, 500);
  await auditMerchant(gate.session, request, 'STAFF_REMOVED', email);
  return merchantJson({ removed: true });
}
