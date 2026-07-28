import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';
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

    // Retrieve the session and expand the setup_intent in one network request
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent'],
    });

    const metadata = session.metadata ?? {};
    const variant = String(metadata.variant ?? '').trim();
    const size = String(metadata.size ?? '').trim();
    const address = String(metadata.address ?? '').trim();
    const quantity = Number(metadata.quantity ?? 1);
    const email = String(metadata.email ?? '').trim();
    const customerId = typeof session.customer === 'string' ? session.customer : String(session.customer ?? '');

    if (!variant || !size || !address || !email || !customerId) {
      return NextResponse.json({ error: 'Incomplete checkout session metadata attributes.' }, { status: 400 });
    }

    // Securely extract the payment method token from the expanded object
    const setupIntent = session.setup_intent as Stripe.SetupIntent | null | undefined;
    const paymentMethodId = typeof setupIntent === 'object' && setupIntent !== null
      ? String(setupIntent.payment_method ?? '')
      : '';

    if (!paymentMethodId) {
      return NextResponse.json({ error: 'Setup flow did not complete with a valid payment method.' }, { status: 400 });
    }

    const normalizedAddressKey = address.toLowerCase().replace(/\s+/g, '');
    const duplicateBlockKey = `drop_fraud_block:${variant}:${size}`;
    const poolKey = `drop_pool:${variant}:${size}`;

    // HIGH SCALABILITY TRANSACTION ANTI-FRAUD CHECK
    const isDuplicate = await redis.sismember(duplicateBlockKey, normalizedAddressKey);
    if (isDuplicate === 1) {
      return NextResponse.json({
        success: true,
        message: 'Entry already recorded for this address. Your payment method is saved.',
      });
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

    // Execute database operations concurrently to prevent serverless function lag
    await Promise.all([
      redis.rpush(poolKey, JSON.stringify(registrationPayload)),
      redis.sadd(duplicateBlockKey, normalizedAddressKey)
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
