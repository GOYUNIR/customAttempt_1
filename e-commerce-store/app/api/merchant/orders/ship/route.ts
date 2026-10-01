import { merchantSession, merchantJson, auditMerchant } from '@/lib/merchant-session';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { validateShipInput } from '@/lib/fulfilment-rules';
import { shipMerchantOrder, merchantOrderDetail, emailShippedOnce } from '@/lib/merchant-orders';

export const dynamic = 'force-dynamic';

/**
 * Mark ONE of this store's orders shipped (v1: the whole order), with carrier
 * and tracking number; the customer gets one "shipped" email from the store.
 * Idempotent: a second press neither re-ships nor re-emails. Owner, staff and
 * support sessions may do it (it is daily work); every press is audited.
 */
export async function POST(request: Request) {
  const gate = await merchantSession(request);
  if (!gate.ok) return gate.response;
  const limited = await rateLimitedResponse('merchant_ship', request, 60, 60);
  if (limited) return limited;
  const body = await request.json().catch(() => null);
  const ref = String(body?.ref || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(ref)) return merchantJson({ error: 'Order not found.' }, 404);
  // Retry only the customer's email for an order already shipped.
  if (body?.emailOnly === true) {
    const email = await emailShippedOnce(gate.session.tenantId, ref);
    if (email === 'not shipped') return merchantJson({ error: 'Order not found, or not shipped yet.' }, 404);
    await auditMerchant(gate.session, request, 'ORDER_SHIPPED_EMAIL_RETRY', ref + ': customer email ' + email);
    return merchantJson({ result: 'already', email, order: await merchantOrderDetail(gate.session.tenantId, ref) });
  }
  const check = validateShipInput(body);
  if (!check.ok) return merchantJson({ error: check.error }, 400);
  const r = await shipMerchantOrder(gate.session.tenantId, ref, check.value, gate.session.email);
  if (!r.ok) return merchantJson({ error: r.error }, r.status);
  await auditMerchant(gate.session, request, r.result === 'shipped' ? 'ORDER_SHIPPED' : 'ORDER_SHIP_REPEATED',
    ref + ': ' + check.value.carrierName + ' ' + check.value.trackingNumber + '; customer email ' + r.email);
  return merchantJson({ result: r.result, email: r.email, order: await merchantOrderDetail(gate.session.tenantId, ref) });
}
