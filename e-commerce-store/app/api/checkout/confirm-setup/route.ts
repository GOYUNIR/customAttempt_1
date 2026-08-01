import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  archiveEntry,
  cleanupMatchingIntent,
  emailBlockKey,
  cardBlockKey,
  poolStatField,
  POOL_STATS_KEY,
  PROCESSED_SESSIONS_KEY,
} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Database or Stripe offline.' }, { status: 500 });
    }

    const body = await request.json();
    const sessionId = String(body?.sessionId || '').trim();
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId.' }, { status: 400 });
    }

    // Idempotent: already confirmed
    const already = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);
    if (already === 1) {
      return NextResponse.json({ success: true, message: 'Your entry is already locked in. Good luck!' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent', 'setup_intent.payment_method'],
    });

    if (session.mode !== 'setup' || session.status !== 'complete') {
      return NextResponse.json({ error: 'Checkout session is not complete yet.' }, { status: 400 });
    }

    const meta = session.metadata || {};
    const email = String(meta.email || session.customer_email || '').trim().toLowerCase();
    const variant = String(meta.variant || '').trim();
    const size = String(meta.size || '50ml').trim();
    const shippingAddress = String(meta.address || '').trim();
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || '';

    if (!email || !variant) {
      return NextResponse.json({ error: 'Session metadata incomplete.' }, { status: 400 });
    }

    let paymentMethodId = '';
    let cardLast4 = '';
    let cardFingerprint = '';

    const setupIntent = session.setup_intent as any;
    if (setupIntent?.payment_method) {
      const pm =
        typeof setupIntent.payment_method === 'string'
          ? await stripe.paymentMethods.retrieve(setupIntent.payment_method)
          : setupIntent.payment_method;
      paymentMethodId = pm.id;
      cardLast4 = pm.card?.last4 || '';
      cardFingerprint = pm.card?.fingerprint || '';
    }

    // Dupe guards
    const emailBlocked = await redis.sismember(emailBlockKey(variant, size), email);
    if (emailBlocked === 1) {
      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
      return NextResponse.json({ success: true, message: 'This email already has a confirmed entry. Good luck!' });
    }
    if (cardFingerprint) {
      const cardBlocked = await redis.sismember(cardBlockKey(variant, size), cardFingerprint);
      if (cardBlocked === 1) {
        await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
        return NextResponse.json({ success: true, message: 'This card already has a confirmed entry. Good luck!' });
      }
    }

    const entry = {
      email,
      variant,
      size,
      shippingAddress,
      address: shippingAddress,
      customerId,
      stripeCustomerId: customerId,
      paymentMethodId,
      cardLast4,
      cardFingerprint,
      sessionId,
      registeredAt: new Date().toISOString(),
      type: 'ENTERED',
    };

    await redis.rpush(`drop_pool:${variant}:${size}`, JSON.stringify(entry));
    await redis.hincrby(POOL_STATS_KEY, poolStatField('sub', variant, size), 1);
    await redis.sadd(emailBlockKey(variant, size), email);
    if (cardFingerprint) await redis.sadd(cardBlockKey(variant, size), cardFingerprint);
    await cleanupMatchingIntent(redis, variant, size, email);
    await archiveEntry(redis, {
      email,
      variant,
      size,
      shippingAddress,
      id: customerId || 'n/a',
      registeredAt: entry.registeredAt,
      type: 'ENTERED',
    });
    await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);

    return NextResponse.json({ success: true, message: 'Your entry is locked in. Good luck on the drop!' });
  } catch (err: any) {
    console.error('confirm-setup error:', err);
    return NextResponse.json({ error: err.message || 'Confirm failed.' }, { status: 500 });
  }
}