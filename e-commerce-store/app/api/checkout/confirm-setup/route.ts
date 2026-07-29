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

const redis = createRedisClient();
const stripe = createStripeClient();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sessionId = String(body?.sessionId ?? '').trim();
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing Stripe checkout session ID.' }, { status: 400 });
    }
    if (!stripe || !redis) {
      return NextResponse.json({ error: 'Critical downstream database infrastructure offline.' }, { status: 500 });
    }

    // Idempotency: the Stripe webhook may ALSO try to process this same
    // session. Whichever path arrives first wins; the other becomes a no-op.
    const alreadyProcessed = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);
    if (alreadyProcessed === 1) {
      return NextResponse.json({
        success: true,
        message: 'Your payment method is saved and your raffle entry is confirmed.',
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent'],
    });

    const metadata = session.metadata ?? {};
    const variant = String(metadata.variant ?? '').trim();
    const size = String(metadata.size ?? '').trim();
    const address = String(metadata.address ?? '').trim();
    const quantity = Number(metadata.quantity ?? 1);
    const email = String(metadata.email ?? '').trim().toLowerCase();
    const customerId = typeof session.customer === 'string' ? session.customer : String(session.customer ?? '');

    if (!variant || !size || !address || !email || !customerId) {
      return NextResponse.json({ error: 'Incomplete checkout session metadata attributes.' }, { status: 400 });
    }

    const setupIntent = session.setup_intent as Stripe.SetupIntent | null | undefined;
    const paymentMethodId = typeof setupIntent === 'object' && setupIntent !== null
      ? String(setupIntent.payment_method ?? '')
      : '';
    if (!paymentMethodId) {
      return NextResponse.json({ error: 'Setup flow did not complete with a valid payment method.' }, { status: 400 });
    }

    // The card's fingerprint identifies the physical card even if someone
    // tries to re-enter under a different email.
    let cardFingerprint = '';
    try {
      const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
      cardFingerprint = paymentMethod.card?.fingerprint ?? '';
    } catch {}

    const emailKey = emailBlockKey(variant, size);
    const cardKey = cardBlockKey(variant, size);

    const [isEmailDuplicate, isCardDuplicate] = await Promise.all([
      redis.sismember(emailKey, email),
      cardFingerprint ? redis.sismember(cardKey, cardFingerprint) : Promise.resolve(0),
    ]);

    await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);

    if (isEmailDuplicate === 1) {
      return NextResponse.json({
        success: true,
        message: 'This email already has a confirmed entry for this drop. Your card is saved either way.',
      });
    }
    if (isCardDuplicate === 1) {
      return NextResponse.json({
        success: true,
        message: 'This payment card is already registered to an entry for this drop.',
      });
    }

    const poolKey = `drop_pool:${variant}:${size}`;
    const registrationPayload = {
      email,
      variant,
      size,
      shippingAddress: address,
      address,
      quantity,
      customerId,
      paymentMethodId,
      registeredAt: Date.now(),
      source: 'redis' as const,
    };

    await Promise.all([
      redis.rpush(poolKey, JSON.stringify(registrationPayload)),
      redis.sadd(emailKey, email),
      cardFingerprint ? redis.sadd(cardKey, cardFingerprint) : Promise.resolve(),
      redis.hincrby(POOL_STATS_KEY, poolStatField('sub', variant, size), 1),
      archiveEntry(redis, {
        email, variant, size, shippingAddress: address,
        id: customerId, registeredAt: new Date().toISOString(), type: 'ENTERED',
      }),
    ]);

    return NextResponse.json({
      success: true,
      message: 'Your payment method is saved and your raffle entry is confirmed.',
    });
  } catch (error: any) {
    console.error('❌ Confirm Setup Internal Pipeline Failure:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}