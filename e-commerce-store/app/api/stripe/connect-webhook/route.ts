import { NextResponse } from 'next/server';
import { resolveStripeClient } from '@/services/payment/factory';
import { resolveConnectWebhookSecret, syncConnectedAccount, tenantIdForAccount } from '@/lib/connect';
import { resolveConnectEventTenant } from '@/lib/connect-routing';
import { claimWebhookKey, completeWebhookKey, releaseWebhookKey } from '@/lib/webhook-dedupe';
import { subrequestCount, reportSubrequests } from '@/lib/subrequest-meter';

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
 *   payment events   -> NOT YET. No charge is made on a connected account until
 *                       the charge paths are wired (CONNECT.md §8 step 4), so
 *                       none should arrive. If one does, it is answered 500 and
 *                       its claim released, so Stripe keeps retrying until a
 *                       handler exists — a payment is never acknowledged
 *                       without being recorded.
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
      const who = resolveConnectEventTenant({
        eventAccount,
        tenantForAccount,
        metadataTenantId: object?.metadata?.tenant_id ?? null,
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
      // Passed the guard, but no handler exists yet. Never acknowledge a
      // payment we have not recorded: release the claim and let Stripe retry.
      console.error('[connect-webhook] ' + event.type + ' for tenant ' + who.tenantId +
        ' arrived before its handler exists (CONNECT.md §8 step 4) — 500 so Stripe retries');
      await releaseWebhookKey(SCOPE, String(event.id));
      return NextResponse.json({ error: 'Not yet handled' }, { status: 500 });
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
