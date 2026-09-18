/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DUNNING — tell a winner their card failed, while their entry is still live.
 *
 * THE BUG THIS EXISTS FOR. When a draw winner's card declines, lib/auto-draw.ts
 * and app/api/admin/trigger-drop archive a `WINNER_DECLINED` entry, mirror it to
 * Postgres, and send the customer NOTHING. They won, the charge failed, their
 * allocation rolled back to the pool, and nobody told them.
 *
 * WHY THIS RECOVERS REAL MONEY RATHER THAN BEING A COURTESY NOTE. The decline
 * path does `remainingEntries.push(...)` — the entry stays IN the pool, so the
 * customer is still live for the next draw. "Your card failed, fix it before
 * the next one" therefore converts a lost allocation into a future sale, with
 * no change to draw mechanics and no decision about grace periods that would
 * affect other entrants.
 *
 * ATTRIBUTION IS DETERMINISTIC, NOT A HOLDOUT (see lib/growth/registry.ts). A
 * holdout here would mean deliberately NOT telling a share of customers their
 * payment failed, in order to measure what telling them is worth. That is not a
 * control group, it is withholding a notice someone needs about their own
 * money.
 *
 * TRANSACTIONAL, so it does not require marketing consent and is exempt from
 * quiet hours: it concerns a purchase the customer already attempted. Gating it
 * behind a marketing opt-in would withhold it from exactly the people who most
 * need it.
 *
 * COST: one email per decline, ~$0.0009. At the volume this platform runs, the
 * module lives comfortably inside Resend's free tier — which is why it ships
 * first: it recovers money before it costs anything.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { EmailFactory } from '@/services/email/factory';
import { createKvClient } from '@/lib/server-config';
import { markEntryEmailSent, isEntryEmailSent } from '@/lib/redis-maintenance';
import { canSend, withinDailyCap } from '@/lib/growth/consent';
import { recordUsage, usageHeadroom } from '@/lib/growth/ledger';
import { headroomMessage } from '@/lib/growth/units';
import { moduleById, assertLaunchable } from '@/lib/growth/registry';
import { getSiteUrl } from '@/lib/env';

export type DeclinedWinner = {
  email: string;
  productName: string;
  size: string;
  /** Distinguishes one decline from another for the same person. */
  declineRef: string;
  /** Why the charge failed, when the engine knows. Never shown verbatim. */
  reason?: string | null;
};

export type DunningResult =
  | { sent: true; costMicros: number | null }
  | { sent: false; reason: string; detail: string };

/** Escape anything interpolated into the email's HTML. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Notify one declined winner. Returns why it did not send, when it did not.
 *
 * Every refusal path returns rather than throws: a draw must never fail because
 * a notification could not go out. The caller records the reason.
 */
export async function notifyDeclinedWinner(
  tenantId: string,
  winner: DeclinedWinner,
): Promise<DunningResult> {
  const growthModule = moduleById('dunning');
  if (!growthModule) return { sent: false, reason: 'no_module', detail: 'dunning is not registered.' };

  // The budget gate, not a formality — see lib/growth/registry.ts.
  const blocked = assertLaunchable(growthModule);
  if (blocked) return { sent: false, reason: 'not_launchable', detail: blocked };

  const email = String(winner.email || '').trim().toLowerCase();
  if (!email) return { sent: false, reason: 'no_contact', detail: 'Declined winner has no email.' };

  const kv = createKvClient();

  // ── 1. already told them about THIS decline? ──────────────────────────────
  // Separate from the frequency cap: the cap is "how often may we contact this
  // person", this is "did we already send this exact message". Without it a
  // re-run of a draw would mail everyone a second time.
  const dedupeKey = 'dunning:' + email + ':' + winner.declineRef;
  if (kv) {
    try {
      if (await isEntryEmailSent(kv, dedupeKey)) {
        return { sent: false, reason: 'already_sent', detail: 'Already notified about ' + winner.declineRef + '.' };
      }
    } catch {
      // A dedupe outage must not block the notice; the worst case is a repeat,
      // and the frequency cap below still bounds it.
    }
  }

  // ── 2. may we send to this person at all? ─────────────────────────────────
  const decision = await canSend({ tenantId, module: growthModule, email });
  if (!decision.allowed) {
    return { sent: false, reason: decision.reason, detail: decision.detail };
  }

  // ── 3. does the TENANT have room today? ───────────────────────────────────
  const cap = await withinDailyCap(tenantId, growthModule);
  if (!cap.within) {
    return {
      sent: false,
      reason: 'daily_cap',
      detail: 'dunning used ' + cap.usedToday + '/' + cap.cap + ' sends today for this tenant.',
    };
  }

  // ── 4. does the PLATFORM have room this month? ────────────────────────────
  // Checked before the send, so the warning arrives while there is still room
  // to act rather than as sends that quietly stop.
  const headroom = await usageHeadroom('email');
  if (headroom) {
    const message = headroomMessage(headroom);
    if (message) console.warn('[dunning] ' + message);
    // Deliberately NOT blocked when exhausted. Overage is $0.90 per 1,000 and
    // this notice is about a customer's failed payment — the wrong economy.
    // Cart recovery, which is marketing, will stop instead.
  }

  // ── 5. send, through the driver ABSTRACTION ───────────────────────────────
  const driver = await EmailFactory.getDriver();
  if (!driver || !driver.configured) {
    return { sent: false, reason: 'no_email_provider', detail: 'No email provider is configured.' };
  }

  const site = getSiteUrl().replace(/\/$/, '');
  const product = esc(winner.productName || 'your item');
  const size = winner.size ? ' (' + esc(winner.size) + ')' : '';

  try {
    const result = await driver.sendTransactional({
      to: email,
      // Left empty on purpose: the driver substitutes the sender configured
      // for this deployment (services/email/resend.driver.ts). A module that
      // hardcoded a from address would break the moment a merchant used their
      // own domain, and would bypass the vendor abstraction it is meant to sit
      // behind.
      from: '',
      subject: 'Your payment did not go through — your entry is still active',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;color:#111;line-height:1.6;background:#fff;border-radius:16px;padding:32px 28px;border:1px solid #e5e7eb;">
          <h1 style="font-size:22px;font-weight:700;margin:0 0 12px">Your card was declined</h1>
          <p style="margin:0 0 14px;color:#4b5563">
            You were selected for <strong>${product}</strong>${size}, but the payment did not go
            through, so we could not complete the order.
          </p>
          <p style="margin:0 0 20px;color:#4b5563">
            <strong>Your entry is still active.</strong> Update your payment method and you will be
            included in the next draw for this release.
          </p>
          <p style="margin:0 0 20px">
            <a href="${site}/account" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:700;font-size:14px">Update payment method</a>
          </p>
          <p style="margin:0;color:#9ca3af;font-size:12px">
            You are receiving this because you entered a release on our store. It is not a
            marketing message.
          </p>
        </div>
      `,
      text:
        'Your card was declined.\n\n' +
        'You were selected for ' + (winner.productName || 'your item') +
        (winner.size ? ' (' + winner.size + ')' : '') +
        ', but the payment did not go through.\n\n' +
        'Your entry is still active. Update your payment method and you will be included in the ' +
        'next draw for this release: ' + site + '/account\n',
    });

    if (!result?.ok) {
      return {
        sent: false,
        reason: 'send_failed',
        detail: 'Provider refused the send: ' + JSON.stringify(result?.error ?? 'unknown'),
      };
    }
  } catch (err) {
    return { sent: false, reason: 'send_failed', detail: (err as Error)?.message || String(err) };
  }

  // ── 6. bookkeeping, after the send ────────────────────────────────────────
  // The reference is `contact:<email>` because that is what the frequency cap
  // counts (lib/growth/consent.ts). Recorded AFTER a successful send so a
  // failed one does not consume the customer's cap.
  const costMicros = await recordUsage({
    tenantId,
    moduleId: growthModule.id,
    unit: 'email',
    quantity: 1,
    reference: 'contact:' + email,
  });

  if (kv) {
    try {
      await markEntryEmailSent(kv, dedupeKey);
    } catch (err) {
      console.error('[dunning] dedupe mark failed for ' + dedupeKey + ' — a re-run may repeat this notice', (err as Error)?.message || err);
    }
  }

  return { sent: true, costMicros };
}

/**
 * Notify a batch of declined winners, one draw's worth.
 *
 * Sequential rather than parallel on purpose: the daily cap and the free-tier
 * headroom are both read-then-act, and firing a hundred sends at once would
 * race past either. A draw's decline list is small, so the latency does not
 * matter; correctness of the caps does.
 */
export async function notifyDeclinedWinners(
  tenantId: string,
  winners: DeclinedWinner[],
): Promise<{ sent: number; skipped: Array<{ email: string; reason: string; detail: string }> }> {
  const skipped: Array<{ email: string; reason: string; detail: string }> = [];
  let sent = 0;
  for (const winner of winners) {
    const result = await notifyDeclinedWinner(tenantId, winner);
    if (result.sent) sent += 1;
    else skipped.push({ email: winner.email, reason: result.reason, detail: result.detail });
  }
  if (skipped.length > 0) {
    console.warn('[dunning] ' + skipped.length + ' declined winner(s) not notified: ' +
      skipped.map((s) => s.reason).join(', '));
  }
  return { sent, skipped };
}
