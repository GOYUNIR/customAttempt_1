import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { validateVariantParam } from '@/lib/merchant-stock-input';

export const dynamic = 'force-dynamic';

/** The last 50 stock changes of one of THIS store's sizes (store AND size both filter). */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const variantId = validateVariantParam(new URL(request.url).searchParams.get('variantId'));
  if (!variantId) return merchantJson({ error: 'Unknown size.' }, 400);
  const rows = (await getDb().select<any>('stock_movements', {
    where: { tenant_id: eq(gate.session.tenantId), variant_id: eq(variantId) },
    select: ['reason', 'delta', 'quantity_after', 'shortfall', 'reference', 'actor', 'note', 'created_at'],
    order: { column: 'id', ascending: false }, limit: 50,
  })) as any[];
  return merchantJson({
    history: rows.map((m) => ({ reason: m.reason, change: m.delta, after: m.quantity_after, shortfall: m.shortfall, by: m.actor, note: m.note, reference: m.reference, at: m.created_at })),
  });
}
