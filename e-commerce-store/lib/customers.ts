/**
 * CUSTOMER IDENTITY — one durable record per person, linked to Stripe.
 *
 * Created for H6, but the reason is not charging. CRM, automated follow-ups,
 * reactivation and referrals all need ONE customer record spanning raffles,
 * FCFS orders and future subscriptions. Storing a Stripe reference per entry
 * (the smaller change) would leave the same person entering three raffles
 * with no single identity to build a history on.
 *
 * Charging paths resolve a Stripe customer THROUGH this row
 * (`stripeCustomerIdForEntry`) instead of holding their own copy, so there is
 * one place where the link lives and one place to fix if it is ever wrong.
 */
import { getDb } from '@/lib/db/client';
import { eq } from '@/lib/db/query';

export type CustomerRow = {
  id: string;
  email: string;
  stripe_customer_id: string | null;
};

const normalizeEmail = (email: unknown): string => String(email || '').trim().toLowerCase();

/**
 * Find or create the customer record for an email, linking it to a Stripe
 * customer when one is supplied. Returns the customer's uuid, or null when it
 * could not be resolved.
 *
 * Idempotent in both directions:
 *   - `customers` is unique on (tenant_id, email), so a concurrent create
 *     collides rather than duplicating; we re-read and use the winner.
 *   - a row that already exists but has no Stripe id yet gets linked, so an
 *     entrant who first appeared as a waitlist join is upgraded in place
 *     rather than duplicated.
 *
 * Never throws: an entry or an order must not fail because CRM bookkeeping
 * did. It returns null and the caller proceeds without the link, which the
 * charging path then reports as a missing payment method rather than
 * silently charging the wrong person.
 */
export async function ensureCustomer(
  tenantId: string,
  email: string,
  stripeCustomerId?: string | null,
): Promise<string | null> {
  const normalized = normalizeEmail(email);
  if (!tenantId || !normalized) return null;
  const stripeId = String(stripeCustomerId || '').trim() || null;

  try {
    const db = getDb();
    const existing = (await db.select<CustomerRow>('customers', {
      where: { tenant_id: eq(tenantId), email: eq(normalized) },
      select: ['id', 'email', 'stripe_customer_id'],
      limit: 1,
    })) as CustomerRow[];

    const row = existing?.[0];
    if (row) {
      // Link, or re-link if Stripe issued a different customer for this
      // person. Overwriting is correct: the newest SetupIntent is the one
      // whose payment methods we will actually charge.
      if (stripeId && row.stripe_customer_id !== stripeId) {
        await db.update(
          'customers',
          { where: { tenant_id: eq(tenantId), id: eq(row.id) } },
          { stripe_customer_id: stripeId },
          { returning: 'default' },
        );
      }
      return row.id;
    }

    const created = (await db.insert<CustomerRow>('customers', {
      tenant_id: tenantId,
      email: normalized,
      stripe_customer_id: stripeId,
    })) as CustomerRow[];
    if (created?.[0]?.id) return created[0].id;
    return null;
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    // A unique violation here is one of TWO different situations, and they
    // need different answers. Returning null for both was wrong: a null means
    // the entry carries no customer, which means it can never be charged --
    // it would win a draw, decline as no_payment_method, roll back to the
    // pool and sit there silently forever.
    if (/duplicate key|already exists|23505/i.test(message)) {
      try {
        // (a) Lost the race on (tenant_id, email): the other writer's row is
        //     the one that exists, so use it.
        const again = (await getDb().select<CustomerRow>('customers', {
          where: { tenant_id: eq(tenantId), email: eq(normalized) },
          select: ['id', 'email', 'stripe_customer_id'],
          limit: 1,
        })) as CustomerRow[];
        if (!again?.[0]?.id && stripeId) {
          // (b) This STRIPE customer is already linked to a different email.
          //     Production creates a Stripe customer per email
          //     (stripe.customers.list({ email }) in the checkout routes), so
          //     this means one Stripe customer now spans two addresses --
          //     typically an email edited in the Stripe dashboard. The Stripe
          //     customer is the stronger identity here (it owns the saved
          //     payment methods we would charge), so the entry links to that
          //     existing record rather than being left unchargeable.
          const byStripe = (await getDb().select<CustomerRow>('customers', {
            where: { tenant_id: eq(tenantId), stripe_customer_id: eq(stripeId) },
            select: ['id', 'email', 'stripe_customer_id'],
            limit: 1,
          })) as CustomerRow[];
          if (byStripe?.[0]?.id) {
            console.warn(
              '[customers] Stripe customer ' + stripeId + ' is already linked to ' + byStripe[0].email +
                ', not ' + normalized + '. Linking this entry to the existing record so it stays chargeable; ' +
                'the two addresses are worth reconciling.',
            );
            return byStripe[0].id;
          }
        }
        if (again?.[0]?.id) {
          if (stripeId && again[0].stripe_customer_id !== stripeId) {
            await getDb().update(
              'customers',
              { where: { tenant_id: eq(tenantId), id: eq(again[0].id) } },
              { stripe_customer_id: stripeId },
              { returning: 'default' },
            );
          }
          return again[0].id;
        }
      } catch { /* fall through */ }
    }
    console.error('[customers] could not resolve a customer record', normalized, message);
    return null;
  }
}

/**
 * The Stripe customer id for a customer uuid, or null.
 *
 * This is the lookup the charging paths use. It exists so no charging code
 * ever reads `customer_id` and assumes it is a Stripe id — the mistake that
 * made executeDrawWithCharging decline every winner.
 */
export async function stripeCustomerIdFor(tenantId: string, customerUuid: string): Promise<string | null> {
  if (!tenantId || !customerUuid) return null;
  try {
    const rows = (await getDb().select<{ stripe_customer_id: string | null }>('customers', {
      where: { tenant_id: eq(tenantId), id: eq(customerUuid) },
      select: ['stripe_customer_id'],
      limit: 1,
    })) as Array<{ stripe_customer_id: string | null }>;
    return rows?.[0]?.stripe_customer_id || null;
  } catch (err) {
    console.error('[customers] Stripe customer lookup failed', customerUuid, (err as Error)?.message || err);
    return null;
  }
}
