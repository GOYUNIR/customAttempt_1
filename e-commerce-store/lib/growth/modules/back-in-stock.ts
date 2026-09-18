/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BACK IN STOCK — tell the people who asked, when it returns.
 *
 * The cheapest module in the set and the one with the clearest intent behind
 * it: one email per person per product, sent to somebody who explicitly asked
 * to be told. At roughly 500 sends a month it sits comfortably inside the free
 * email allowance, which is why it ships before cart recovery despite being
 * worth less per send.
 *
 * WHO GETS TOLD. `public.alert_subscribers` (migration 00023) is the
 * store-wide release list, and `notified_slugs` on each subscriber is what
 * stops the same person being told about the same product twice. That map is
 * the dedupe; this module reads and extends it rather than keeping its own.
 *
 * MARKETING, so it goes through the same gate as cart recovery: explicit
 * opt-in, quiet hours in the recipient's timezone, frequency cap.
 *
 * IT RUNS A HOLDOUT, at 10%. That is higher than cart recovery's 8% because the
 * population is smaller — a tenth of a short list is still too few to conclude
 * from quickly, and a holdout that never reaches significance is a holdout that
 * costs sends and proves nothing. `computeIncremental` refuses to call a small
 * comparison reliable, so the number stays honest while the list grows.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { EmailFactory } from '@/services/email/factory';
import { canSend, withinDailyCap } from '@/lib/growth/consent';
import { recordUsage, usageHeadroom } from '@/lib/growth/ledger';
import { headroomMessage } from '@/lib/growth/units';
import { moduleById, assertLaunchable } from '@/lib/growth/registry';
import { isHeldOut } from '@/lib/growth/holdout';
import { listSubscribers, markNotified, type AlertSubscriber } from '@/lib/alert-subscribers';
import { getSiteUrl } from '@/lib/env';

export type RestockedProduct = {
  slug: string;
  name: string;
  /** Units now available. Used only to decide whether to send at all. */
  available: number;
};

export type RestockOutcome = {
  notified: number;
  heldOut: number;
  skipped: Array<{ email: string; reason: string }>;
};

/**
 * Tell interested subscribers that one product is available again.
 *
 * Takes the product rather than discovering it, so the caller decides what
 * "back in stock" means for their commerce mode — a restocked retail line and a
 * newly opened drop are different events, and this module should not guess
 * which one happened.
 */
export async function notifyBackInStock(
  tenantId: string,
  product: RestockedProduct,
): Promise<RestockOutcome> {
  const outcome: RestockOutcome = { notified: 0, heldOut: 0, skipped: [] };

  const growthModule = moduleById('back_in_stock');
  if (!growthModule) {
    outcome.skipped.push({ email: '-', reason: 'not_registered' });
    return outcome;
  }
  const blocked = assertLaunchable(growthModule);
  if (blocked) {
    outcome.skipped.push({ email: '-', reason: 'disabled: ' + blocked });
    return outcome;
  }

  // Nothing to announce. Guarded here rather than at the call site because
  // "we restocked" emails for zero units are the fastest way to teach a list
  // to ignore you.
  if (!product.slug || product.available <= 0) {
    outcome.skipped.push({ email: '-', reason: 'nothing_available' });
    return outcome;
  }

  const cap = await withinDailyCap(tenantId, growthModule);
  if (!cap.within) {
    outcome.skipped.push({ email: '-', reason: 'daily_cap ' + cap.usedToday + '/' + cap.cap });
    return outcome;
  }

  // Marketing, so it stops when the free allowance is gone rather than quietly
  // spending. Same rule as cart recovery, opposite of dunning.
  const headroom = await usageHeadroom('email');
  if (headroom) {
    const message = headroomMessage(headroom);
    if (message) console.warn('[back-in-stock] ' + message);
    if (headroom.exceeded) {
      outcome.skipped.push({ email: '-', reason: 'free email allowance exhausted' });
      return outcome;
    }
  }

  const driver = await EmailFactory.getDriver();
  if (!driver || !driver.configured) {
    outcome.skipped.push({ email: '-', reason: 'no_email_provider' });
    return outcome;
  }

  const subscribers = await listSubscribers(tenantId);
  const site = getSiteUrl().replace(/\/$/, '');

  for (const subscriber of subscribers) {
    if (subscriber.status === 'unsubscribed') {
      outcome.skipped.push({ email: subscriber.email, reason: 'unsubscribed' });
      continue;
    }
    // Already told about THIS product. The subscriber's own notified_slugs map
    // is the record, so a second run announces nothing twice.
    if (subscriber.notifiedSlugs[product.slug]) {
      outcome.skipped.push({ email: subscriber.email, reason: 'already_notified' });
      continue;
    }

    // Held-out subscribers are left alone AND left unmarked, so that if the
    // experiment is later turned off they are still eligible to hear about
    // this product. Marking them would silently retire them from the list.
    if (isHeldOut(growthModule.id, subscriber.email + ':' + product.slug, growthModule.attribution.holdoutPercent)) {
      outcome.heldOut += 1;
      continue;
    }

    // The subscriber row IS the consent: they asked to hear about releases, in
    // writing, on a date. Handed to the gate as evidence to be judged rather
    // than as a claim to be believed — and a decline on their customer record
    // still overrules it.
    const decision = await canSend({
      tenantId,
      module: growthModule,
      email: subscriber.email,
      listConsent: {
        source: 'alert_subscribers',
        status: subscriber.status,
        recordedAt: subscriber.createdAt,
      },
    });
    if (!decision.allowed) {
      outcome.skipped.push({ email: subscriber.email, reason: decision.reason });
      continue;
    }

    if (!(await sendRestockEmail(driver, subscriber, product, site))) {
      outcome.skipped.push({ email: subscriber.email, reason: 'send_failed' });
      continue;
    }

    await recordUsage({
      tenantId,
      moduleId: growthModule.id,
      unit: 'email',
      quantity: 1,
      reference: 'contact:' + subscriber.email,
    });
    // Marked only after a successful send: marking first would suppress a
    // retry of an announcement that never went out.
    await markNotified(tenantId, subscriber, product.slug);
    outcome.notified += 1;
  }

  return outcome;
}

async function sendRestockEmail(
  driver: NonNullable<Awaited<ReturnType<typeof EmailFactory.getDriver>>>,
  subscriber: AlertSubscriber,
  product: RestockedProduct,
  site: string,
): Promise<boolean> {
  const name = escapeHtml(product.name || 'A product you wanted');
  try {
    const result = await driver.sendTransactional({
      from: '',
      to: subscriber.email,
      subject: name + ' is back',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">${name} is available again</h1>
          <p style="margin:0 0 18px;color:#4b5563">You asked to hear when this came back. It has.</p>
          <p style="margin:0 0 20px">
            <a href="${site}/${encodeURIComponent(product.slug)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:700;font-size:14px">View it</a>
          </p>
          <p style="margin:0;color:#9ca3af;font-size:12px">
            You are on this list because you asked to be told about releases. Unsubscribe any time.
          </p>
        </div>
      `,
      text:
        (product.name || 'A product you wanted') + ' is available again.\n\n' +
        'You asked to hear when this came back: ' + site + '/' + product.slug + '\n',
    });
    return result?.ok === true;
  } catch {
    return false;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fire the announcement when a variant crosses from out-of-stock to available.
 *
 * THE TRANSITION IS THE EVENT, not the restock. Going from 5 units to 10 is a
 * top-up and nobody is waiting for it; going from 0 to anything is the thing
 * people asked to hear about. Sending on every restock would train the list to
 * ignore the emails, which costs more than the sends do.
 *
 * Best-effort and never throws: a restock is an inventory operation, and it
 * must not fail because an announcement could not go out.
 */
export async function notifyIfBackInStock(
  tenantId: string,
  variantId: string,
  quantityBefore: number,
  quantityAfter: number,
): Promise<void> {
  if (quantityBefore > 0 || quantityAfter <= 0) return;

  try {
    const { getDb } = await import('@/lib/db/client');
    const { eq } = await import('@/lib/db/query');
    const db = getDb();

    const variants = (await db.select<{ product_id: string }>('product_variants', {
      where: { id: eq(variantId) }, select: ['product_id'], limit: 1,
    })) as Array<{ product_id: string }>;
    const productId = variants?.[0]?.product_id;
    if (!productId) return;

    const products = (await db.select<{ slug: string; name: string }>('products', {
      where: { tenant_id: eq(tenantId), id: eq(productId) },
      select: ['slug', 'name'], limit: 1,
    })) as Array<{ slug: string; name: string }>;
    const product = products?.[0];
    if (!product?.slug) return;

    const outcome = await notifyBackInStock(tenantId, {
      slug: product.slug,
      name: product.name,
      available: quantityAfter,
    });
    if (outcome.notified > 0 || outcome.heldOut > 0) {
      console.log(
        '[back-in-stock] ' + product.slug + ': notified ' + outcome.notified +
        ', held back ' + outcome.heldOut + ' for measurement',
      );
    }
  } catch (err) {
    console.error('[back-in-stock] announcement failed for variant ' + variantId,
      (err as Error)?.message || err);
  }
}
