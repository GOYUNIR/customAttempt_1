import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

export const dynamic = 'force-dynamic';

/**
 * Remove a PENDING entry from one of THIS store's raffles or waitlists (it will
 * not be drawn or charged). The update matches the entry id AND the session's
 * store AND 'pending' together, so another store's entry, or one already
 * decided, is untouched and reads as not found.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const body = await request.json().catch(() => ({}));
  const entryId = String(body?.entryId || '');
  if (!/^[0-9a-f-]{36}$/.test(entryId)) return merchantJson({ error: 'Unknown entry.' }, 400);
  const rows = (await getDb().update<any>('raffle_entries',
    { where: { id: eq(entryId), tenant_id: eq(gate.session.tenantId), status: eq('pending') } },
    { status: 'cancelled', decided_at: new Date().toISOString() },
  )) as any[];
  if (rows.length === 0) return merchantJson({ error: 'That entry is not pending in your store.' }, 404);
  await auditMerchant(gate.session, request, 'ENTRY_CANCELLED', String(rows[0].email || entryId));
  return merchantJson({ cancelled: true });
}
