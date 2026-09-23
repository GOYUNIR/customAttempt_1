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

/** One thing sold, within one payment. */
export type RecordOrderLine = {
  /** The product's `external_id`, used to resolve the variant. */
  externalProductId?: string | null;
  productName: string;
  size: string;
  quantity: number;
  /** This LINE's total in cents (unit price × quantity), not the order total. */
  amountCents: number;
};

/**
 * A CART IS ONE ORDER WITH MANY LINES, and that is why `lines` exists.
 *
 * The webhook's cart branch used to call this once per cart item with the ONE
 * order_ref taken from the session metadata. Since the order upserts on
 * (tenant_id, order_ref) and the line items are REPLACED rather than appended,
 * each item silently erased the one before it. Measured against the real
 * catalog: a cart of Roccstar 50ml ($19) + Black Solstice 50ml ×2 ($50) charged
 * $69 and recorded a single order of $50 with a single Black Solstice line.
 * The $19 product was not in the order at all — not as revenue, and not as
 * anything a fulfilment screen could tell you to ship.
 *
 * Splitting it into several orders instead would have been the smaller change
 * and the wrong one: one Stripe payment would become N orders sharing one
 * payment intent, which inflates order counts and makes per-payment fee
 * reconciliation (what Connect needs) ambiguous.
 */
export type RecordOrderInput = {
  tenantId: string;
  orderRef: string;
  email: string;
  checkoutMode?: string | null;
  promoCode?: string | null;
  stripeCustomerId?: string | null;
  stripePaymentIntentId?: string | null;
} & (
  // Single-line callers (direct checkout, the raffle draw, the webhook's
  // non-cart branch) sell exactly one thing and keep the original shape.
  | ({ lines?: undefined } & RecordOrderLine)
  // Multi-line callers pass every line; the order total is their SUM.
  | { lines: RecordOrderLine[] }
);

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

  // ONE code path for both shapes: a single-line caller is just a cart of one.
  // Normalised BEFORE the try so the failure log below can report the real
  // amount at risk — that message exists to say how much money was taken with
  // no order behind it, and it cannot do that from a total it cannot see.
  const rawLines: RecordOrderLine[] = input.lines?.length
    ? input.lines
    : [input as RecordOrderLine];
  const lines = rawLines.map((line) => ({
    externalProductId: line.externalProductId ?? null,
    productName: String(line.productName || ''),
    size: String(line.size || ''),
    quantity: Math.max(1, Math.floor(Number(line.quantity) || 1)),
    amountCents: Math.max(0, Math.round(Number(line.amountCents) || 0)),
  }));
  if (lines.length === 0) {
    return { ok: false, reason: 'error', message: 'An order needs at least one line.' };
  }
  // The order total is the sum of what was actually sold. Taking it from a
  // caller-supplied total instead would let the header and the lines disagree.
  const amountCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

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
          // Kept for the single-line readers that already index on these.
          productName: lines[0].productName || null,
          size: lines[0].size || null,
          // A cart's full contents, so metadata does not describe only its
          // first line when there are several.
          ...(lines.length > 1
            ? { lines: lines.map((l) => ({ productName: l.productName, size: l.size, quantity: l.quantity, amountCents: l.amountCents })) }
            : {}),
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

    // WHAT was sold, per line. Nullable on purpose: a product that predates the
    // Postgres catalog has no variant to point at, and losing the order over
    // that would be worse than an unlinked line.
    const resolved = await Promise.all(lines.map(async (line) => {
      let variantId: string | null = null;
      if (line.externalProductId) {
        try {
          variantId = await resolveVariantId(input.tenantId, String(line.externalProductId), String(line.size || ''));
        } catch (err) {
          console.error('[order-write] variant lookup failed for ' + line.externalProductId + '/' + line.size,
            (err as Error)?.message || err);
        }
      }
      if (!variantId) {
        console.warn('[order-write] order ' + orderRef + ' has a line with no variant_id (' +
          String(line.externalProductId || 'no external id') + '/' + String(line.size || '') +
          ') — per-variant reporting will not see it');
      }
      return { ...line, variantId };
    }));

    // Replace the line items rather than appending, so a webhook RETRY does not
    // double the order's contents while the upsert above correctly leaves the
    // order itself alone.
    await db.remove('order_line_items', { where: { tenant_id: eq(input.tenantId), order_id: eq(orderId) } });
    await db.insert('order_line_items', resolved.map((line) => ({
      tenant_id: input.tenantId,
      order_id: orderId,
      variant_id: line.variantId,
      quantity: line.quantity,
      unit_price_cents: Math.max(0, Math.round(line.amountCents / line.quantity)),
      line_total_cents: line.amountCents,
    })), { returning: 'minimal' });

    // `variantLinked` means EVERY line resolved. Reporting true while one line
    // of a cart is unlinked would hide exactly the gap it exists to reveal.
    return { ok: true, orderId, variantLinked: resolved.every((line) => Boolean(line.variantId)) };
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    // LOUD. The customer has already been charged by the time this runs.
    console.error(
      '[order-write] ORDER NOT RECORDED for ' + orderRef + ' (' + email + ', ' + amountCents +
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
