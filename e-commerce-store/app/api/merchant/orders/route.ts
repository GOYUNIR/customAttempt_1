import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

export const dynamic = 'force-dynamic';

/** The signed-in merchant's orders, newest first. Read-only. */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const rows = (await getDb().select<any>('orders', {
    where: { tenant_id: eq(gate.session.tenantId) },
    select: ['id', 'order_ref', 'status', 'payment_status', 'total_cents', 'currency', 'platform_fee_cents', 'checkout_mode', 'created_at', 'metadata', { relation: 'customers', columns: ['email'] }],
    order: { column: 'created_at', ascending: false },
    limit: 200,
  })) as any[];
  return merchantJson({
    orders: rows.map((o) => ({
      ref: o.order_ref,
      status: o.status,
      paymentStatus: o.payment_status,
      totalCents: o.total_cents,
      currency: o.currency,
      platformFeeCents: o.platform_fee_cents,
      mode: o.checkout_mode,
      createdAt: o.created_at,
      customerEmail: o.customers?.email ?? null,
      item: o.metadata?.lines ? o.metadata.lines.map((l: any) => l.productName + ' (' + l.size + ') x' + l.quantity).join(', ') : (o.metadata?.productName ? o.metadata.productName + (o.metadata.size ? ' (' + o.metadata.size + ')' : '') : null),
    })),
  });
}
