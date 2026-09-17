/**
 * ORDER WRITES — Postgres is where a sale is recorded.
 *
 * This replaces lib/postgres-shadow-write.ts, whose contract was "best-effort,
 * shadow only, never affects the real transaction". That was the right contract
 * while nothing read the rows. It is the wrong one now, and the difference
 * matters for three specific reasons the shadow version got away with:
 *
 *   1. IT SWALLOWED FAILURES. A failed write logged `console.warn` and returned.
 *      By the time this function runs the customer's card HAS BEEN CHARGED, so
 *      a silent failure is money taken with no order behind it. The result is
 *      now returned and the caller is expected to act on it.
 *
 *   2. IT CREATED CUSTOMERS ITS OWN WAY. `findOrCreateShadowCustomer` was a
 *      second, parallel path to `lib/customers.ts`'s ensureCustomer — it never
 *      linked a Stripe customer id and never went through the identity logic
 *      H6/H7 built. Two ways to create a customer is how the same person ends
 *      up as two rows. This uses the one path.
 *
 *   3. IT NEVER SET variant_id. `order_line_items.variant_id` exists and was
 *      always left NULL, so an order could not say WHAT was sold — only a price
 *      and a quantity. That makes per-variant revenue, inventory
 *      reconciliation and returns impossible to compute from orders.
 *
 * IDEMPOTENT on (tenant_id, order_ref). Stripe retries webhook deliveries, and
 * a retry must update the existing order rather than creating a second one for
 * the same payment.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';
import { ensureCustomer } from '@/lib/customers';
import { resolveVariantId } from '@/lib/inventory';

/** 00013's CHECK constraint. Anything else is preserved in metadata instead. */
const CHECKOUT_MODES = ['fcfs', 'raffle', 'waitlist', 'rfq_quote'] as const;

export type RecordOrderInput = {
  tenantId: string;
  orderRef: string;
  email: string;
  /** The product's `external_id`, used to resolve the variant. */
  externalProductId?: string | null;
  productName: string;
  size: string;
  quantity: number;
  amountCents: number;
  checkoutMode?: string | null;
  promoCode?: string | null;
  stripeCustomerId?: string | null;
  stripePaymentIntentId?: string | null;
};

export type RecordOrderResult =
  | { ok: true; orderId: string; variantLinked: boolean }
  | { ok: false; reason: 'not_configured' | 'no_customer' | 'error'; message: string };

export async function recordOrder(input: RecordOrderInput): Promise<RecordOrderResult> {
  const db = getDb();
  if (!db.configured) {
    return { ok: false, reason: 'not_configured', message: 'Supabase is not configured.' };
  }
  const email = String(input.email || '').trim().toLowerCase();
  const orderRef = String(input.orderRef || '').trim();
  if (!orderRef) {
    return { ok: false, reason: 'error', message: 'An order needs an order_ref.' };
  }

  try {
    // ONE customer path, shared with raffles, carts and the loyalty balance.
    const customerId = await ensureCustomer(input.tenantId, email, input.stripeCustomerId ?? null);
    if (!customerId) {
      // Not fatal to the sale — the order is still recorded, just unattributed.
      // Refusing here would lose the order over a CRM lookup.
      console.error('[order-write] no customer record for ' + email + ' — the order will be unattributed');
    }

    const normalizedMode = String(input.checkoutMode || '').trim().toLowerCase();
    const realCheckoutMode = (CHECKOUT_MODES as readonly string[]).includes(normalizedMode)
      ? normalizedMode
      : null;

    const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
    const amountCents = Math.max(0, Math.round(Number(input.amountCents) || 0));

    const orderRows = (await db.insert<{ id: string }>(
      'orders',
      {
        tenant_id: input.tenantId,
        customer_id: customerId,
        order_ref: orderRef,
        status: 'confirmed',
        payment_status: 'paid',
        subtotal_cents: amountCents,
        total_cents: amountCents,
        currency: 'usd',
        checkout_mode: realCheckoutMode,
        stripe_payment_intent_id: input.stripePaymentIntentId || null,
        metadata: {
          checkoutMode: input.checkoutMode || null,
          promoCode: input.promoCode || null,
          productName: input.productName || null,
          size: input.size || null,
        },
      },
      // A retried webhook delivery reuses the same order_ref (unique per
      // tenant) — merge against THAT constraint, not the primary key, or
      // PostgREST's default upsert target would miss it and insert a duplicate.
      { onConflict: 'tenant_id,order_ref' },
    )) as Array<{ id: string }>;

    const orderId = orderRows?.[0]?.id;
    if (!orderId) {
      return { ok: false, reason: 'error', message: 'The order row was not returned after insert.' };
    }

    // WHAT was sold. Nullable on purpose: a product that predates the Postgres
    // catalog has no variant to point at, and losing the order over that would
    // be worse than an unlinked line.
    let variantId: string | null = null;
    if (input.externalProductId) {
      try {
        variantId = await resolveVariantId(input.tenantId, String(input.externalProductId), String(input.size || ''));
      } catch (err) {
        console.error('[order-write] variant lookup failed for ' + input.externalProductId + '/' + input.size,
          (err as Error)?.message || err);
      }
    }
    if (!variantId) {
      console.warn('[order-write] order ' + orderRef + ' has no variant_id (' +
        String(input.externalProductId || 'no external id') + '/' + String(input.size || '') +
        ') — per-variant reporting will not see it');
    }

    // Replace the line items rather than appending, so a webhook RETRY does not
    // double the order's contents while the upsert above correctly leaves the
    // order itself alone.
    await db.remove('order_line_items', { where: { tenant_id: eq(input.tenantId), order_id: eq(orderId) } });
    await db.insert('order_line_items', [{
      tenant_id: input.tenantId,
      order_id: orderId,
      variant_id: variantId,
      quantity,
      unit_price_cents: Math.max(0, Math.round(amountCents / quantity)),
      line_total_cents: amountCents,
    }], { returning: 'minimal' });

    return { ok: true, orderId, variantLinked: Boolean(variantId) };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    // LOUD. The customer has already been charged by the time this runs.
    console.error(
      '[order-write] ORDER NOT RECORDED for ' + orderRef + ' (' + email + ', ' + input.amountCents +
        ' cents). The payment succeeded and there is no order row. ' + message,
    );
    return { ok: false, reason: 'error', message };
  }
}

/** An order by its reference, or null. */
export async function findOrderByRef(tenantId: string, orderRef: string) {
  try {
    const rows = await getDb().select<Record<string, unknown>>('orders', {
      where: { tenant_id: eq(tenantId), order_ref: eq(orderRef) },
      select: ['id', 'order_ref', 'status', 'payment_status', 'total_cents', 'checkout_mode', 'customer_id', 'created_at', 'metadata'],
      limit: 1,
    });
    return rows?.[0] ?? null;
  } catch (err) {
    console.error('[order-write] lookup failed', orderRef, (err as Error)?.message || err);
    return null;
  }
}
