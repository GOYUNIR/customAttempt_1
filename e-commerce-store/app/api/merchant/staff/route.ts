import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { listInvites } from '@/lib/staff-invites';

export const dynamic = 'force-dynamic';

/** The people of THIS store, and its invites. Owner only. */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can manage staff.' }, 403);
  const tenantId = gate.session.tenantId;
  const [people, invites] = await Promise.all([
    getDb().select<any>('users', { where: { tenant_id: eq(tenantId) }, select: ['email', 'role', 'full_name', 'created_at'] }),
    listInvites(tenantId),
  ]);
  return merchantJson({
    people: (people as any[]).map((p) => ({ email: p.email, role: p.role, name: p.full_name ?? null, since: p.created_at, you: p.email === gate.session.email })),
    invites: invites.filter((i) => i.tenantId === tenantId).map((i) => ({ id: i.id, email: i.email, role: i.role, status: i.status, expiresAt: i.expiresAt })),
  });
}
