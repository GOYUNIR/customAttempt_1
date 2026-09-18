/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CART RECOVERY — remind someone about the cart they left behind.
 *
 * SHIPPED DISABLED, on purpose. The registry marks it `planned`, so
 * `assertLaunchable` refuses to run it. The reason is arithmetic, not caution:
 * three emails per abandoned cart, and a merchant doing ~2,000 orders a month
 * abandons enough carts to consume Resend's entire 3,000/month free allowance
 * on their own. This module costs money the moment it is switched on, so it
 * waits for a merchant whose plan covers the $20 Pro tier.
 *
 * Everything below is built and tested so that switching it on is a status
 * change in the registry plus a paid plan — not a fortnight of work at the
 * moment somebody finally needs it.
 *
 * THIS IS THE FIRST MODULE WITH A HOLDOUT. A percentage of carts are
 * deliberately NOT contacted so the merchant's report can say what the emails
 * ADDED rather than what they touched. Assignment is a stable hash of the cart
 * id (lib/growth/holdout.ts), so the same cart is in the same group on every
 * run and a retry can never mail somebody who was meant to be held back.
 *
 * MARKETING, not transactional. A cart is not a purchase, so this requires an
 * explicit opt-in, respects quiet hours in the recipient's own timezone, and is
 * bounded by a frequency cap. The gate in lib/growth/consent.ts enforces all
 * three; nothing here is trusted to remember.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { getDb } from '@/lib/db/client';
import { eq, lt } from '@/lib/db/query';
import { EmailFactory } from '@/services/email/factory';
import { createKvClient } from '@/lib/server-config';
import { markEntryEmailSent, isEntryEmailSent } from '@/lib/redis-maintenance';
import { canSend, withinDailyCap } from '@/lib/growth/consent';
import { recordUsage, usageHeadroom } from '@/lib/growth/ledger';
import { headroomMessage } from '@/lib/growth/units';
import { moduleById, assertLaunchable } from '@/lib/growth/registry';
import { isHeldOut } from '@/lib/growth/holdout';
import { getSiteUrl } from '@/lib/env';

/** How long a cart sits untouched before it counts as abandoned. */
export const ABANDONED_AFTER_MINUTES = 60;

export type AbandonedCart = {
  cartId: string;
  email: string;
  itemCount: number;
  totalCents: number;
};

export type RecoveryOutcome = {
  contacted: number;
  heldOut: number;
  skipped: Array<{ cartId: string; reason: string }>;
};

/**
 * Carts that have gone quiet, with the customer who owns them.
 *
 * Only carts with a CUSTOMER are returned: an anonymous cart has nobody to
 * email, and including it would make the holdout percentages meaningless by
 * counting people who could never have been contacted either way.
 */
export async function findAbandonedCarts(tenantId: string, limit = 200): Promise<AbandonedCart[]> {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_MINUTES * 60_000).toISOString();
  const db = getDb();

  const carts = (await db.select<{ id: string; customer_id: string | null }>('carts', {
    where: { tenant_id: eq(tenantId), status: eq('active'), updated_at: lt(cutoff) },
    select: ['id', 'customer_id'],
    limit,
  })) as Array<{ id: string; customer_id: string | null }>;

  const withCustomer = carts.filter((c) => c.customer_id);
  if (withCustomer.length === 0) return [];

  const out: AbandonedCart[] = [];
  for (const cart of withCustomer) {
    const [items, customers] = await Promise.all([
      db.select<{ quantity: number; unit_price_cents: number }>('cart_items', {
        where: { tenant_id: eq(tenantId), cart_id: eq(cart.id) },
        select: ['quantity', 'unit_price_cents'],
        limit: 100,
      }) as Promise<Array<{ quantity: number; unit_price_cents: number }>>,
      db.select<{ email: string }>('customers', {
        where: { tenant_id: eq(tenantId), id: eq(String(cart.customer_id)) },
        select: ['email'],
        limit: 1,
      }) as Promise<Array<{ email: string }>>,
    ]);

    const email = customers?.[0]?.email;
    // An empty cart is not abandoned, it is just empty — mailing about it would
    // be a reminder to buy nothing.
    if (!email || items.length === 0) continue;

    out.push({
      cartId: cart.id,
      email,
      itemCount: items.reduce((n, i) => n + (Number(i.quantity) || 0), 0),
      totalCents: items.reduce((n, i) => n + (Number(i.quantity) || 0) * (Number(i.unit_price_cents) || 0), 0),
    });
  }
  return out;
}

/**
 * Run one pass over the abandoned carts.
 *
 * Sequential, like dunning: the daily cap and the free-tier headroom are both
 * read-then-act, and firing a batch in parallel would race straight past either.
 */
export async function recoverAbandonedCarts(tenantId: string): Promise<RecoveryOutcome> {
  const outcome: RecoveryOutcome = { contacted: 0, heldOut: 0, skipped: [] };

  const growthModule = moduleById('cart_recovery');
  if (!growthModule) {
    outcome.skipped.push({ cartId: '-', reason: 'not_registered' });
    return outcome;
  }

  // THE GATE THAT KEEPS THIS OFF. Until the registry says 'live' and a plan
  // covers the email cost, this returns without sending anything.
  const blocked = assertLaunchable(growthModule);
  if (blocked) {
    outcome.skipped.push({ cartId: '-', reason: 'disabled: ' + blocked });
    return outcome;
  }

  const cap = await withinDailyCap(tenantId, growthModule);
  if (!cap.within) {
    outcome.skipped.push({ cartId: '-', reason: 'daily_cap ' + cap.usedToday + '/' + cap.cap });
    return outcome;
  }

  // Unlike dunning, this one STOPS when the free allowance is gone. A
  // failed-payment notice is worth paying overage for; a marketing reminder is
  // not, and quietly spending money on it is exactly what the budget rule
  // exists to prevent.
  const headroom = await usageHeadroom('email');
  if (headroom) {
    const message = headroomMessage(headroom);
    if (message) console.warn('[cart-recovery] ' + message);
    if (headroom.exceeded) {
      outcome.skipped.push({ cartId: '-', reason: 'free email allowance exhausted' });
      return outcome;
    }
  }

  const carts = await findAbandonedCarts(tenantId);
  const kv = createKvClient();
  const driver = await EmailFactory.getDriver();
  if (!driver || !driver.configured) {
    outcome.skipped.push({ cartId: '-', reason: 'no_email_provider' });
    return outcome;
  }

  for (const cart of carts) {
    // THE HOLDOUT. Counted, not silently dropped: the control group is the
    // evidence, so it has to be visible in the outcome.
    if (isHeldOut(growthModule.id, cart.cartId, growthModule.attribution.holdoutPercent)) {
      outcome.heldOut += 1;
      continue;
    }

    const dedupeKey = 'cart_recovery:' + cart.cartId;
    if (kv) {
      try {
        if (await isEntryEmailSent(kv, dedupeKey)) {
          outcome.skipped.push({ cartId: cart.cartId, reason: 'already_sent' });
          continue;
        }
      } catch {
        // A dedupe outage must not stop the run; the frequency cap still bounds it.
      }
    }

    const decision = await canSend({ tenantId, module: growthModule, email: cart.email });
    if (!decision.allowed) {
      outcome.skipped.push({ cartId: cart.cartId, reason: decision.reason });
      continue;
    }

    const site = getSiteUrl().replace(/\/$/, '');
    const itemWord = cart.itemCount === 1 ? 'item' : 'items';
    try {
      const result = await driver.sendTransactional({
        // Empty so the driver supplies the deployment's configured sender.
        from: '',
        to: cart.email,
        subject: 'You left something behind',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
            <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">Still thinking it over?</h1>
            <p style="margin:0 0 16px;color:#4b5563">
              You have ${cart.itemCount} ${itemWord} waiting in your cart.
            </p>
            <p style="margin:0 0 20px">
              <a href="${site}/catalog" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:700;font-size:14px">Return to your cart</a>
            </p>
            <p style="margin:0;color:#9ca3af;font-size:12px">
              You are receiving this because you opted in to updates. You can unsubscribe at any time.
            </p>
          </div>
        `,
        text:
          'Still thinking it over?\n\nYou have ' + cart.itemCount + ' ' + itemWord +
          ' waiting in your cart: ' + site + '/catalog\n',
      });
      if (!result?.ok) {
        outcome.skipped.push({ cartId: cart.cartId, reason: 'send_failed' });
        continue;
      }
    } catch {
      outcome.skipped.push({ cartId: cart.cartId, reason: 'send_failed' });
      continue;
    }

    // Recorded after a successful send, so a failure does not consume the
    // customer's frequency cap. The reference is what that cap counts.
    await recordUsage({
      tenantId,
      moduleId: growthModule.id,
      unit: 'email',
      quantity: 1,
      reference: 'contact:' + cart.email,
    });
    if (kv) {
      try {
        await markEntryEmailSent(kv, dedupeKey);
      } catch {
        // Worst case is a repeat on the next run, bounded by the frequency cap.
      }
    }
    outcome.contacted += 1;
  }

  return outcome;
}
