import { NextResponse } from 'next/server';
import { resolveStripeClient } from '@/services/payment/factory';
import { resolveConnectWebhookSecret, syncConnectedAccount, tenantIdForAccount } from '@/lib/connect';
import { resolveConnectEventTenant } from '@/lib/connect-routing';
import { claimWebhookKey, completeWebhookKey, releaseWebhookKey } from '@/lib/webhook-dedupe';
import { subrequestCount, reportSubrequests } from '@/lib/subrequest-meter';
import { handleConnectCheckoutCompleted, handleConnectChargeRefunded } from '@/lib/tenant-checkout';
import { recordTenantEntryFromSetupSession } from '@/lib/tenant-drops';

export const dynamic = 'force-dynamic';

/**
 * STRIPE CONNECT WEBHOOK — events that happen ON a merchant's connected
 * account (CONNECT.md §5). A separate endpoint from /api/stripe/webhook, which
 * keeps serving the legacy platform tenant; Stripe signs this one with its own
 * secret (00034).
 *
 * THE GUARD. The tenant is resolved from `event.account` — the account the
 * event happened on — and nothing else. Payment events must also carry our own
 * `metadata.tenant_id`, and if it names a different tenant the event is
 * refused: it touches no order, no stock, no ledger. That is what stops one
 * merchant's event from ever acting on another merchant's data
 * (lib/connect-routing.ts, tested).
 *
 * WHAT IS WIRED TODAY
 *   account.updated  -> re-read the account FROM STRIPE (never trusting the
 *                       payload) and refresh the tenant's cached status. This
 *                       is what flips connect_charges_enabled when a merchant
 *                       finishes onboarding.
 *   checkout.session.completed (mode setup) -> the raffle/waitlist entry,
 *                       with the card's account (lib/tenant-drops.ts).
 *   checkout.session.completed -> the order, the fee record, the stock
 *                       decrement (lib/tenant-checkout.ts). A failure before
 *                       the order is written is a 500 + released claim, so
 *                       Stripe retries: a payment is never acknowledged
 *                       without its order.
 *   charge.refunded  -> D5: our fee on the sale is returned in proportion, and
 *                       the month's running total is reduced.
 *   charge.dispute.created -> logged. The fee is KEPT (TENANCY.md T11); the
 *                       dispute debits the merchant's balance. Its tenant comes
 *                       from the PaymentIntent (disputes carry no metadata).
 *   payment_intent.succeeded -> acknowledged; the session event records it.
 *
 * Dedupe: webhook_dedupe, scope 'stripe_connect_event', keyed by event id.
 */
const SCOPE = 'stripe_connect_event';
const PAYMENT_EVENTS = new Set([
  'checkout.session.completed',
  'payment_intent.succeeded',
  'charge.refunded',
  'charge.dispute.created',
]);

export async function POST(request: Request) {
  const started = subrequestCount();
  const [stripe, secret] = await Promise.all([resolveStripeClient(), resolveConnectWebhookSecret()]);
  if (!stripe || !secret) {
    // 503, not 400: once the secret is stored, Stripe's retry delivers
    // whatever arrived before it. Nothing is ever accepted unsigned.
    console.error('[connect-webhook] no Connect signing secret configured — refusing (Stripe will retry)');
    return NextResponse.json({ error: 'Connect webhook not configured' }, { status: 503 });
  }

  let event: any;
  try {
    const raw = await request.text();
    if (raw.length > 1_000_000) return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    const sig = request.headers.get('stripe-signature');
    if (!sig) return NextResponse.json({ error: 'Signature required' }, { status: 400 });
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('[connect-webhook] signature verification failed', (err as Error)?.message || err);
    return NextResponse.json({ error: 'Webhook Error' }, { status: 400 });
  }

  const eventAccount: string | null = typeof event.account === 'string' ? event.account : null;

  let claim: Awaited<ReturnType<typeof claimWebhookKey>>;
  try {
    claim = await claimWebhookKey(SCOPE, String(event.id));
  } catch (err) {
    console.error('[connect-webhook] dedupe unavailable for ' + event.id + ' — 503 so Stripe retries', (err as Error)?.message || err);
    return NextResponse.json({ error: 'Temporarily unable to process' }, { status: 503 });
  }
  if (claim === 'duplicate') return NextResponse.json({ received: true, skipped: 'already_processed' });

  try {
    const tenantForAccount = eventAccount ? await tenantIdForAccount(eventAccount) : null;

    if (event.type === 'account.updated') {
      const who = resolveConnectEventTenant({ eventAccount, tenantForAccount, requireMetadata: false });
      if (!who.ok) {
        // Not ours to act on (an account no tenant owns). Acknowledge so
        // Stripe stops retrying a permanent condition, and say so.
        console.error('[connect-webhook] account.updated for ' + eventAccount + ' ignored: ' + who.reason);
        await completeWebhookKey(SCOPE, String(event.id));
        return NextResponse.json({ received: true, ignored: who.reason });
      }
      const synced = await syncConnectedAccount(String(eventAccount));
      await completeWebhookKey(SCOPE, String(event.id));
      reportSubrequests('connect-webhook account.updated', started);
      return NextResponse.json({ received: true, tenant: who.tenantId, chargesEnabled: synced.chargesEnabled });
    }

    if (PAYMENT_EVENTS.has(event.type)) {
      const object = event.data?.object || {};
      let metadataTenantId: string | null = object?.metadata?.tenant_id ?? null;
      if (event.type === 'charge.dispute.created' && !metadataTenantId && eventAccount && object?.payment_intent) {
        // Stripe puts no metadata on a dispute; ours is on its PaymentIntent.
        const pi = await stripe.paymentIntents.retrieve(String(object.payment_intent), {}, { stripeAccount: eventAccount });
        metadataTenantId = pi?.metadata?.tenant_id ?? null;
      }
      const who = resolveConnectEventTenant({
        eventAccount,
        tenantForAccount,
        metadataTenantId,
        requireMetadata: true,
      });
      if (!who.ok) {
        // Permanent: retrying cannot make a foreign or unstamped event ours.
        // Nothing was touched. Loud, and acknowledged.
        console.error('[connect-webhook] REFUSED ' + event.type + ' ' + event.id + ' on ' + eventAccount +
          ': ' + who.reason + ' — no order, stock or ledger was touched');
        await completeWebhookKey(SCOPE, String(event.id));
        return NextResponse.json({ received: true, refused: who.reason });
      }
      let result: { handled: boolean; note: string } = { handled: false, note: 'acknowledged' };
      if (event.type === 'checkout.session.completed' && object?.mode === 'setup') {
        // A raffle/waitlist entry's card was saved (phase 4). Throws until it
        // can be recorded, so Stripe retries: an entry is never dropped.
        result = await recordTenantEntryFromSetupSession(object, who.tenantId, String(eventAccount));
      } else if (event.type === 'checkout.session.completed') {
        result = await handleConnectCheckoutCompleted(object, who.tenantId, String(eventAccount));
      } else if (event.type === 'charge.refunded') {
        result = await handleConnectChargeRefunded(object, String(eventAccount));
      } else if (event.type === 'charge.dispute.created') {
        console.error('[connect-webhook] DISPUTE ' + object?.id + ' on ' + eventAccount + ' (tenant ' + who.tenantId + '), ' +
          object?.amount + ' ' + object?.currency + ', reason ' + object?.reason + ' — debits the merchant; platform fee kept (T11)');
        result = { handled: true, note: 'dispute logged' };
      }
      await completeWebhookKey(SCOPE, String(event.id));
      console.log('[connect-webhook] ' + event.type + ' ' + event.id + ' tenant ' + who.tenantId + ': ' + result.note);
      reportSubrequests('connect-webhook ' + event.type, started);
      return NextResponse.json({ received: true, tenant: who.tenantId, ...result });
    }

    await completeWebhookKey(SCOPE, String(event.id));
    return NextResponse.json({ received: true, ignored: event.type });
  } catch (err) {
    // Hand the event back so a retry can do the work.
    await releaseWebhookKey(SCOPE, String(event.id));
    console.error('[connect-webhook] ' + event.type + ' ' + event.id + ' failed — 500 so Stripe retries', (err as Error)?.message || err);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
