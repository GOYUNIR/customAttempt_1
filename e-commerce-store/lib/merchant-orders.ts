/**
 * MERCHANT ORDERS — list, detail and "mark shipped" for ONE store.
 *
 * Every read and write is scoped by the tenant id from the merchant session,
 * never from input: an order of another store is simply not found. Shipping
 * goes through mark_order_shipped (00043), which checks the store again in
 * the database, so the isolation does not rest on this file alone.
 *
 * Refunds are NOT done here: they happen in the merchant's own Stripe
 * Dashboard (linked from the order) and come back through charge.refunded.
 */
import { getDb } from '@/lib/db/client';
import { eq, inList } from '@/lib/db/query';
import { stripePaymentLink, orderStage, type ShipInput } from '@/lib/fulfilment-rules';
import { stripeIsTestMode } from '@/services/payment/factory';
import { sendStoreEmailOnce, renderOrderShipped } from '@/lib/tenant-email';

const ORDER_COLUMNS = ['id', 'order_ref', 'status', 'payment_status', 'subtotal_cents', 'discount_cents', 'tax_cents', 'total_cents', 'currency',
  'platform_fee_cents', 'refunded_cents', 'refunded_at', 'checkout_mode', 'stripe_payment_intent_id', 'created_at', 'metadata'];

type Line = { productName: string; size: string; quantity: number; unitCents: number; lineCents: number };

function linesFrom(order: any, items: any[]): Line[] {
  if (items.length > 0) {
    // Names from the catalog when the line is linked; else what the order kept.
    const meta: any[] = Array.isArray(order.metadata?.lines) ? order.metadata.lines : [{ productName: order.metadata?.productName, size: order.metadata?.size }];
    return items.map((it, i) => ({
      productName: String(it.product_variants?.products?.name || meta[i]?.productName || 'Item'),
      size: String(it.product_variants?.option_label || meta[i]?.size || ''),
      quantity: Number(it.quantity) || 1,
      unitCents: Number(it.unit_price_cents) || 0,
      lineCents: Number(it.line_total_cents) || 0,
    }));
  }
  return [{ productName: String(order.metadata?.productName || 'Item'), size: String(order.metadata?.size || ''), quantity: 1, unitCents: Number(order.total_cents) || 0, lineCents: Number(order.total_cents) || 0 }];
}

/** This store's orders, newest first, with where each one stands. */
export async function listMerchantOrders(tenantId: string) {
  const rows = (await getDb().select<any>('orders', {
    where: { tenant_id: eq(tenantId) },
    select: ['id', 'order_ref', 'status', 'payment_status', 'total_cents', 'currency', 'platform_fee_cents', 'refunded_cents', 'checkout_mode', 'created_at', 'metadata', { relation: 'customers', columns: ['email'] }] as any,
    order: { column: 'created_at', ascending: false },
    limit: 200,
  })) as any[];
  const shipped = rows.length === 0 ? [] : (await getDb().select<any>('order_fulfilments', {
    where: { tenant_id: eq(tenantId), order_id: inList(rows.map((o) => String(o.id))) }, select: ['order_id', 'shipped_at'],
  })) as any[];
  const shippedAt = new Map(shipped.map((f) => [String(f.order_id), String(f.shipped_at)]));
  return rows.map((o) => ({
    ref: o.order_ref,
    status: o.status,
    paymentStatus: o.payment_status,
    stage: orderStage({ paymentStatus: o.payment_status, shippedAt: shippedAt.get(String(o.id)) || null }),
    totalCents: o.total_cents,
    refundedCents: Number(o.refunded_cents || 0),
    currency: o.currency,
    platformFeeCents: o.platform_fee_cents,
    mode: o.checkout_mode,
    createdAt: o.created_at,
    shippedAt: shippedAt.get(String(o.id)) || null,
    customerEmail: o.customers?.email ?? null,
    item: o.metadata?.lines ? o.metadata.lines.map((l: any) => l.productName + ' (' + l.size + ') x' + l.quantity).join(', ') : (o.metadata?.productName ? o.metadata.productName + (o.metadata.size ? ' (' + o.metadata.size + ')' : '') : null),
  }));
}

/** One order of this store, by its reference; null when it is not this store's. */
export async function merchantOrderDetail(tenantId: string, ref: string) {
  const db = getDb();
  const order = ((await db.select<any>('orders', {
    where: { tenant_id: eq(tenantId), order_ref: eq(ref) },
    select: [...ORDER_COLUMNS, { relation: 'customers', columns: ['email', 'full_name'] }] as any, limit: 1,
  })) as any[])[0];
  if (!order) return null;
  const [items, fulfilment] = await Promise.all([
    db.select<any>('order_line_items', {
      where: { tenant_id: eq(tenantId), order_id: eq(String(order.id)) },
      select: ['quantity', 'unit_price_cents', 'line_total_cents', { relation: 'product_variants', columns: ['option_label', { relation: 'products', columns: ['name'] }] }] as any,
    }) as Promise<any[]>,
    db.select<any>('order_fulfilments', {
      where: { tenant_id: eq(tenantId), order_id: eq(String(order.id)) },
      select: ['carrier', 'tracking_number', 'tracking_url', 'shipped_at', 'shipped_by', 'customer_emailed_at'], limit: 1,
    }).then((r: any) => (r as any[])[0] || null) as Promise<any>,
  ]);
  const total = Number(order.total_cents) || 0;
  const fee = Number(order.platform_fee_cents) || 0;
  const refunded = Number(order.refunded_cents) || 0;
  const timeline: Array<{ at: string; what: string }> = [{ at: order.created_at, what: 'Paid' }];
  if (fulfilment) timeline.push({ at: fulfilment.shipped_at, what: 'Shipped with ' + fulfilment.carrier + ' (' + fulfilment.tracking_number + ')' + (fulfilment.shipped_by ? ' by ' + fulfilment.shipped_by : '') });
  if (fulfilment?.customer_emailed_at) timeline.push({ at: fulfilment.customer_emailed_at, what: 'Customer emailed that it shipped' });
  if (refunded > 0 && order.refunded_at) timeline.push({ at: order.refunded_at, what: (refunded >= total ? 'Refunded' : 'Partly refunded') + ' in Stripe' });
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    id: String(order.id),
    ref: order.order_ref,
    createdAt: order.created_at,
    status: order.status,
    paymentStatus: order.payment_status,
    stage: orderStage({ paymentStatus: order.payment_status, shippedAt: fulfilment?.shipped_at || null }),
    mode: order.checkout_mode,
    customer: { email: order.customers?.email ?? null, name: order.customers?.full_name ?? null, shippingAddress: order.metadata?.shippingAddress ?? null },
    lines: linesFrom(order, items as any[]),
    totals: {
      currency: order.currency,
      subtotalCents: Number(order.subtotal_cents) || 0,
      discountCents: Number(order.discount_cents) || 0,
      taxCents: Number(order.tax_cents) || 0,
      totalCents: total,
      platformFeeCents: fee,
      refundedCents: refunded,
    },
    fulfilment: fulfilment ? {
      carrier: fulfilment.carrier, trackingNumber: fulfilment.tracking_number, trackingUrl: fulfilment.tracking_url,
      shippedAt: fulfilment.shipped_at, shippedBy: fulfilment.shipped_by, customerEmailedAt: fulfilment.customer_emailed_at,
    } : null,
    stripePaymentUrl: stripePaymentLink(order.stripe_payment_intent_id, await stripeIsTestMode()),
    timeline,
  };
}

/**
 * Mark one order of THIS store shipped, then email the customer ONCE from the
 * store's own sender. Pressing it again never re-ships and never re-emails
 * (a failed email is retried by pressing again: the once-only claim is given
 * back on failure).
 */
export async function shipMerchantOrder(tenantId: string, ref: string, input: ShipInput, by: string): Promise<
  { ok: true; result: 'shipped' | 'already'; email: string } | { ok: false; status: number; error: string }
> {
  const order = ((await getDb().select<any>('orders', {
    where: { tenant_id: eq(tenantId), order_ref: eq(ref) }, select: ['id', 'order_ref', 'metadata', { relation: 'customers', columns: ['email'] }] as any, limit: 1,
  })) as any[])[0];
  if (!order) return { ok: false, status: 404, error: 'Order not found.' };
  const { readSupabaseEnv, supabaseRestFetch } = await import('@/services/config/supabase-client');
  const r = String(await supabaseRestFetch('/rpc/mark_order_shipped', {
    key: readSupabaseEnv().serviceRoleKey, method: 'POST',
    body: { p_tenant: tenantId, p_order: String(order.id), p_carrier: input.carrierName, p_tracking: input.trackingNumber, p_tracking_url: input.trackingUrl, p_by: by },
  })).replace(/"/g, '');
  if (r === 'not_found') return { ok: false, status: 404, error: 'Order not found.' };
  if (r === 'not_paid') return { ok: false, status: 409, error: 'This order is not paid (or was fully refunded), so it cannot be shipped.' };
  if (r !== 'shipped' && r !== 'already') return { ok: false, status: 500, error: 'The order could not be marked shipped. Try again.' };
  return { ok: true, result: r, email: await emailShippedOnce(tenantId, ref) };
}

/**
 * The "shipped" email for an order ALREADY marked shipped, at most once. Uses
 * what was RECORDED (the first press), never a later request's input. Also
 * the retry when the first send failed.
 */
export async function emailShippedOnce(tenantId: string, ref: string): Promise<string> {
  const detail = await merchantOrderDetail(tenantId, ref);
  const f = detail?.fulfilment;
  if (!detail || !f) return 'not shipped';
  const to = String(detail.customer.email || '');
  if (!to) return 'skipped (no customer email)';
  if (f.customerEmailedAt) return 'already sent';
  const m = await sendStoreEmailOnce({
    tenantId, kind: 'shipped', key: ref, to,
    build: (store) => renderOrderShipped(store, { orderRef: ref, carrier: f.carrier, trackingNumber: f.trackingNumber, trackingUrl: f.trackingUrl, lines: detail.lines }),
  });
  if (m.status === 'sent' || m.status === 'duplicate') {
    await getDb().update('order_fulfilments', { where: { tenant_id: eq(tenantId), order_id: eq(detail.id) } }, { customer_emailed_at: new Date().toISOString() }, { returning: 'minimal' } as any).catch(() => null);
  }
  return m.status + (m.note ? ' (' + m.note + ')' : '');
}
