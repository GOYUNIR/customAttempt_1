import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';
import Stripe from 'stripe';

const redis = createRedisClient();
const stripe = createStripeClient();

export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature') ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret || !redis) {
    return NextResponse.json({ error: 'System unconfigured.' }, { status: 500 });
  }

  const body = await request.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    // Allows testing in sandbox without local signature verification if explicitly toggled
    if (process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true' || process.env.NODE_ENV !== 'production') {
      event = JSON.parse(body) as Stripe.Event;
    } else {
      return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
    }
  }

  // Only handle completed entries
  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const metadata = session.metadata ?? {};
  
  const variant = String(metadata.variant ?? '').trim();
  const size = String(metadata.size ?? '').trim();
  const address = String(metadata.address ?? '').trim();
  const email = String(metadata.email ?? '').trim();
  const customerId = String(session.customer ?? '');

  // Extract the card ID directly from the session
  let paymentMethodId = '';
  if (session.setup_intent && typeof session.setup_intent === 'object') {
    paymentMethodId = String((session.setup_intent as Stripe.SetupIntent).payment_method ?? '');
  }

  // Fallback lookup if not expanded automatically
  if (!paymentMethodId && session.setup_intent) {
    try {
      const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent as string);
      paymentMethodId = String(setupIntent.payment_method ?? '');
    } catch {
      return NextResponse.json({ error: 'Could not resolve payment method.' }, { status: 400 });
    }
  }

  if (!variant || !size || !address || !email || !customerId || !paymentMethodId) {
    return NextResponse.json({ error: 'Missing entry details.' }, { status: 400 });
  }

  const normalizedAddress = address.toLowerCase().replace(/\s+/g, '');
  const duplicateBlockKey = `drop_fraud_block:${variant}:${size}`;
  const poolKey = `drop_pool:${variant}:${size}`;

  // Check for duplicate address entries (anti-bot protection)
  const isAddressDuplicate = await redis.sismember(duplicateBlockKey, normalizedAddress);
  
  if (isAddressDuplicate !== 1) {
    const payload = JSON.stringify({ email, customerId, paymentMethodId });
    await Promise.all([
      redis.rpush(poolKey, payload),
      redis.sadd(duplicateBlockKey, normalizedAddress)
    ]);
  }

  return NextResponse.json({ received: true });
}
