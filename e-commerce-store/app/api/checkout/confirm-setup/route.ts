import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  archiveEntry,
  resolveCustomerId,
  emailBlockKey,
  cardBlockKey,
  poolStatField,
  POOL_STATS_KEY,
  PROCESSED_SESSIONS_KEY,
  cleanupMatchingIntent,
} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'System offline.' }, { status: 500 });
    }

    const body = await request.json();
    const sessionId = String(body?.sessionId || '');
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    const already = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);
    if (already === 1) {
      return NextResponse.json({ success: true, message: 'Entry already confirmed.' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent', 'setup_intent.payment_method'],
    });

    if (session.mode !== 'setup' || session.status !== 'complete') {
      return NextResponse.json({ error: 'Session not complete.' }, { status: 400 });
    }

    const meta = session.metadata || {};
    const email = String(meta.email || session.customer_email || '')
      .trim()
      .toLowerCase();
    const variant = String(meta.variant || '');
    const size = String(meta.size || '50ml');
    const shippingAddress = String(meta.address || '');
    const promoCode = String(meta.promoCode || '')
      .trim()
      .toUpperCase();

    if (!email || !variant) {
      return NextResponse.json({ error: 'Missing metadata on session.' }, { status: 400 });
    }

    const setupIntent = session.setup_intent as any;
    const paymentMethodId =
      typeof setupIntent === 'object'
        ? setupIntent?.payment_method?.id || setupIntent?.payment_method
        : null;
    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id || '';

    let cardFingerprint = '';
    try {
      if (paymentMethodId && typeof paymentMethodId === 'string') {
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        cardFingerprint = String(pm.card?.fingerprint || '');
      }
    } catch {}

    // Dupe guard
    const blocked = await redis.sismember(emailBlockKey(variant, size), email);
    if (blocked === 1) {
      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
      return NextResponse.json({
        success: true,
        alreadyEntered: true,
        message: 'Already registered for this allocation.',
      });
    }

    const entry = {
      email,
      variant,
      size,
      shippingAddress,
      customerId,
      paymentMethodId,
      cardFingerprint,
      promoCode: promoCode || undefined,
      registeredAt: new Date().toISOString(),
    };

    await redis.rpush(`drop_pool:${variant}:${size}`, JSON.stringify(entry));
    await redis.sadd(emailBlockKey(variant, size), email);
    if (cardFingerprint) await redis.sadd(cardBlockKey(variant, size), cardFingerprint);
    await redis.hincrby(POOL_STATS_KEY, poolStatField('sub', variant, size), 1);
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

    // Attribute promo on successful entry (revenue counted on charge in trigger-drop)
    if (promoCode) {
      try {
        const raw = await redis.hget(PROMOS_KEY, promoCode);
        const promo = safeParseRedisItem<any>(raw);
        if (promo && promo.active !== false) {
          // block self-use
          if (
            promo.promoterEmail &&
            String(promo.promoterEmail).toLowerCase() === email
          ) {
            // still entered; no promo credit
          } else {
            promo.uses = (promo.uses || 0) + 1;
            await redis.hset(PROMOS_KEY, { [promoCode]: JSON.stringify(promo) });
          }
        }
      } catch {}
    }

    await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);

    return NextResponse.json({
      success: true,
      message: 'Entry locked in. Good luck.',
      email,
      address: shippingAddress,
    });
  } catch (err: any) {
    console.error('confirm-setup', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}