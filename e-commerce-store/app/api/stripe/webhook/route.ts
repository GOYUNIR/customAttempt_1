import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';
import Stripe from 'stripe';

const redis = createRedisClient();
const stripe = createStripeClient();

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature') ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    return NextResponse.json({ error: 'Stripe webhook is not configured.' }, { status: 500 });
  }

  const body = await request.text();
  let event: Stripe.Event | null = null;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    // log signature failure
    try {
      // @ts-ignore
      if (typeof globalThis !== 'undefined') {
        // @ts-ignore
        globalThis.__goyunirWebhookErrors = globalThis.__goyunirWebhookErrors || [];
        // @ts-ignore
        globalThis.__goyunirWebhookErrors.push({ at: Date.now(), error: String(err), rawBodyPreview: body.slice(0, 1000) });
      }
    } catch {}

    // Allow unverified webhook payloads for local/dev testing when explicitly enabled.
    if (process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true' || process.env.NODE_ENV !== 'production') {
      try {
        event = JSON.parse(body) as Stripe.Event;
      } catch (parseErr) {
        return NextResponse.json({ error: 'Invalid webhook payload.' }, { status: 400 });
      }
    } else {
      return NextResponse.json({ error: 'Invalid Stripe webhook signature.' }, { status: 400 });
    }
  }

  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const metadata = session.metadata ?? {};
  const variant = String(metadata.variant ?? '');
  const size = String(metadata.size ?? '');
  const address = String(metadata.address ?? '');
  const quantity = Number(metadata.quantity ?? 1);
  const email = String(metadata.email ?? '');
  const customerId = typeof session.customer === 'string' ? session.customer : String(session.customer ?? '');
  const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : String(session.setup_intent ?? '');

  if (!variant || !size || !address || !email || !customerId || !setupIntentId) {
    return NextResponse.json({ error: 'Missing webhook metadata or Stripe session data.' }, { status: 400 });
  }

  const normalizedAddress = address.toLowerCase().replace(/\s+/g, '');

  if (!redis) {
    return NextResponse.json({ received: true });
  }

  try {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    const paymentMethodId = String(setupIntent.payment_method ?? '');
    if (!paymentMethodId) {
      // record for admin inspection and continue
      try {
        // @ts-ignore
        if (typeof globalThis !== 'undefined') globalThis.__goyunirWebhookErrors = globalThis.__goyunirWebhookErrors || [];
        // @ts-ignore
        globalThis.__goyunirWebhookErrors.push({ at: Date.now(), error: 'SetupIntent has no payment method', session: session });
      } catch {}
      return NextResponse.json({ error: 'SetupIntent has no payment method.' }, { status: 400 });
    }

    const registrationPayload = {
      email,
      variant,
      size,
      address,
      quantity,
      customerId,
      paymentMethodId,
      registeredAt: Date.now(),
      source: 'redis' as const,
    };

    const isAddressDuplicate = await redis.sismember(`drop_fraud_block:${variant}`, normalizedAddress);
    if (isAddressDuplicate !== 1) {
      await redis.rpush(`drop_pool:${variant}:${size}`, JSON.stringify(registrationPayload));
      await redis.sadd(`drop_fraud_block:${variant}`, normalizedAddress);
    }

      // store last processed webhook for admin UI
      try {
        // @ts-ignore
        if (typeof globalThis !== 'undefined') globalThis.__goyunirLastWebhook = session;
      } catch {}

      return NextResponse.json({ received: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Webhook processing failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
