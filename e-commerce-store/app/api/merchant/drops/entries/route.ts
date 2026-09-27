import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

export const dynamic = 'force-dynamic';

/**
 * The entries for one of THIS store's items: email, type, status, dates. The
 * variant must belong to the session's store (both filters apply), so another
 * store's variant id simply returns nothing. No card detail is ever sent.
 */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const variantId = String(new URL(request.url).searchParams.get('variantId') || '');
  if (!/^[0-9a-f-]{36}$/.test(variantId)) return merchantJson({ error: 'Unknown item.' }, 400);
  const rows = (await getDb().select<any>('raffle_entries', {
    where: { tenant_id: eq(gate.session.tenantId), variant_id: eq(variantId) },
    select: ['id', 'email', 'entry_type', 'status', 'submitted_at', 'decided_at'],
    order: { column: 'submitted_at', ascending: true },
    limit: 500,
  })) as any[];
  return merchantJson({ entries: rows.map((r) => ({ id: r.id, email: r.email, type: r.entry_type, status: r.status, submittedAt: r.submitted_at, decidedAt: r.decided_at })) });
}
