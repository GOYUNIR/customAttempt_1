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

    if (!stripe) {
      return NextResponse.json({ error: 'Stripe is not configured.' }, { status: 500 });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent'],
    });

    const metadata = session.metadata ?? {};
    const variant = String(metadata.variant ?? '');
    const size = String(metadata.size ?? '');
    const address = String(metadata.address ?? '');
    const quantity = Number(metadata.quantity ?? 1);
    const email = String(metadata.email ?? '');
    const customerId = typeof session.customer === 'string' ? session.customer : String(session.customer ?? '');

    if (!variant || !size || !address || !email || !customerId) {
      return NextResponse.json({ error: 'Incomplete checkout session metadata.' }, { status: 400 });
    }

    const setupIntent = session.setup_intent as Stripe.SetupIntent | string | null | undefined;
    const paymentMethodId = typeof setupIntent === 'string'
      ? ''
      : String(setupIntent?.payment_method ?? '');

    if (!paymentMethodId) {
      return NextResponse.json({ error: 'Setup flow did not complete with a payment method.' }, { status: 400 });
    }

    const normalizedAddressKey = address.toLowerCase().replace(/\s+/g, '');
    const duplicateBlockKey = `drop_fraud_block:${variant}:${size}`;

    if (!redis) {
      try {
        // @ts-ignore
        if (typeof globalThis !== 'undefined') {
          // @ts-ignore
          globalThis.__goyunirLastWebhook = session;
        }
      } catch {}

      return NextResponse.json({
        success: true,
        warning: 'Redis is not configured. Your entry will remain pending until backend storage is available.',
      });
    }

    const isDuplicate = await redis.sismember(duplicateBlockKey, normalizedAddressKey);
    if (isDuplicate === 1) {
      try {
        // @ts-ignore
        if (typeof globalThis !== 'undefined') {
          // @ts-ignore
          globalThis.__goyunirLastWebhook = session;
        }
      } catch {}

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

    await redis.rpush(`drop_pool:${variant}:${size}`, JSON.stringify(registrationPayload));
    await redis.sadd(duplicateBlockKey, normalizedAddressKey);

    try {
      // @ts-ignore
      if (typeof globalThis !== 'undefined') {
        // @ts-ignore
        globalThis.__goyunirLastWebhook = session;
      }
    } catch {}

    return NextResponse.json({
      success: true,
      message: 'Your payment method is saved and your raffle entry is confirmed.',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to confirm setup session.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
