import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq, isNull } from '@/lib/db/query';

export const dynamic = 'force-dynamic';

/**
 * Revoke a pending invite of THIS store (owner only). The update matches the
 * invite id AND the session's store AND not-yet-accepted together; the shared
 * revokeInvite() is not store-scoped, so it is not used here.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  if (gate.session.role !== 'owner') return merchantJson({ error: 'Only the store owner can manage staff.' }, 403);
  const body = await request.json().catch(() => ({}));
  const id = String(body?.inviteId || '');
  if (!/^[0-9a-f-]{36}$/.test(id)) return merchantJson({ error: 'Unknown invite.' }, 400);
  const rows = (await getDb().update<any>('staff_invites',
    { where: { id: eq(id), tenant_id: eq(gate.session.tenantId), accepted_at: isNull() } },
    { revoked_at: new Date().toISOString() },
  )) as any[];
  if (rows.length === 0) return merchantJson({ error: 'That invite is not pending in your store.' }, 404);
  await auditMerchant(gate.session, request, 'STAFF_INVITE_REVOKED', String(rows[0].email || id));
  return merchantJson({ revoked: true });
}
