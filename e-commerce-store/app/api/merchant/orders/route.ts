import { merchantSession, merchantJson } from '@/lib/merchant-session';
import { listMerchantOrders, merchantOrderDetail } from '@/lib/merchant-orders';

export const dynamic = 'force-dynamic';

/**
 * The signed-in merchant's orders, newest first; or ONE order with ?ref=
 * (customer, lines, totals, our fee, payment and refund status, shipping,
 * timeline, the link to the payment in their own Stripe Dashboard).
 * Read-only; this store's orders only (the store comes from the session).
 */
export async function GET(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const ref = new URL(request.url).searchParams.get('ref');
  if (ref !== null) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(ref)) return merchantJson({ error: 'Order not found.' }, 404);
    const order = await merchantOrderDetail(gate.session.tenantId, ref);
    return order ? merchantJson({ order }) : merchantJson({ error: 'Order not found.' }, 404);
  }
  return merchantJson({ orders: await listMerchantOrders(gate.session.tenantId) });
}
