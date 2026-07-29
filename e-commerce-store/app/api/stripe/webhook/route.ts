import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  archiveEntry,
  emailBlockKey,
  cardBlockKey,
  poolStatField,
  POOL_STATS_KEY,
  PROCESSED_SESSIONS_KEY,
} from '@/lib/server-config';
import Stripe from 'stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const redis = createRedisClient();
  const stripe = createStripeClient();

  const signature = request.headers.get('stripe-signature') ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret || !redis) {
    return NextResponse.json({ error: 'System processing nodes offline.' }, { status: 500 });
  }

  const body = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    if (process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true' || process.env.NODE_ENV !== 'production') {
      event = JSON.parse(body) as Stripe.Event;
    } else {
      return NextResponse.json({ error: 'Invalid webhook signature buffer.' }, { status: 400 });
    }
  }

  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as any;
  const sessionId = String(session.id || '');

  const alreadyProcessed = sessionId ? await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId) : 0;
  if (alreadyProcessed === 1) {
    return NextResponse.json({ received: true, note: 'Already processed by confirm-setup.' });
  }

  const metadata = session.metadata ?? {};
  const variant = String(metadata.variant || '').trim();
  const size = String(metadata.size || '').trim();
  const email = String(metadata.email || session.customer_details?.email || '').trim().toLowerCase();
  const customerId = String(session.customer || '');

  let address = String(metadata.address || metadata.shippingAddress || '').trim();
  if ((!address || address === 'Collected via Stripe Checkout') && session.shipping_details?.address) {
    const addr = session.shipping_details.address;
    address = `${addr.line1 || ''}, ${addr.city || ''}, ${addr.state || ''} ${addr.postal_code || ''}`;
  }

  let paymentMethodId = '';
  const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id || '';
  if (setupIntentId) {
    try {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      paymentMethodId = typeof setupIntent.payment_method === 'string'
        ? setupIntent.payment_method
        : setupIntent.payment_method?.id || '';
    } catch {
      paymentMethodId = '';
    }
  }

  if (!variant || !size || !address || !email || !customerId) {
    console.error('CRITICAL WEBHOOK ERROR: Incomplete payload mapping attributes:', { variant, size, address, email, customerId });
    return NextResponse.json({ error: 'Incomplete checkout session metadata attributes.' }, { status: 400 });
  }

  let cardFingerprint = '';
  let cardLast4 = '';
  if (paymentMethodId) {
    try {
      const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
      cardFingerprint = paymentMethod.card?.fingerprint ?? '';
      cardLast4 = paymentMethod.card?.last4 ?? '';
    } catch {}
  }

  const emailKey = emailBlockKey(variant, size);
  const cardKey = cardBlockKey(variant, size);

  const [isEmailDuplicate, isCardDuplicate] = await Promise.all([
    redis.sismember(emailKey, email),
    cardFingerprint ? redis.sismember(cardKey, cardFingerprint) : Promise.resolve(0),
  ]);

  if (sessionId) await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);

  if (isEmailDuplicate !== 1 && isCardDuplicate !== 1) {
    const poolKey = `drop_pool:${variant}:${size}`;
    const intentKey = `intent_pool:${variant}:${size}`;
    const payload = JSON.stringify({
      email,
      variant,
      size,
      shippingAddress: address,
      address,
      quantity: 1,
      paymentMethodId: paymentMethodId || 'vaulted_token_hold',
      customerId,
      stripeCustomerId: customerId,
      cardFingerprint,
      cardLast4,
      id: session.id || `session_${Math.random().toString(36).substring(2, 7)}`,
      price: 120,
      registeredAt: new Date().toISOString(),
      type: metadata.registrationType === 'WAITLIST_BACKORDER' ? 'WAITLIST' : 'SUBMISSION',
    });

    await Promise.all([
      redis.rpush(poolKey, payload),
      redis.sadd(emailKey, email),
      cardFingerprint ? redis.sadd(cardKey, cardFingerprint) : Promise.resolve(),
      redis.hincrby(POOL_STATS_KEY, poolStatField('sub', variant, size), 1),
      archiveEntry(redis, {
        email, variant, size, shippingAddress: address,
        id: customerId, registeredAt: new Date().toISOString(), type: 'ENTERED',
      }),
    ]);

    try {
      const intentItems = await redis.lrange(intentKey, 0, -1);
      for (const item of intentItems) {
        try {
          const parsedIntent = typeof item === 'string' ? JSON.parse(item) : (item as any);
          if (parsedIntent.email === email) {
            await redis.lrem(intentKey, 1, item);
            await redis.hincrby(POOL_STATS_KEY, poolStatField('int', variant, size), -1);
          }
        } catch {}
      }
    } catch {}
  }

  return NextResponse.json({ received: true });
}