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
  const redis = createRedisClient();
  const stripe = createStripeClient();
  if (!redis || !stripe) {
    return NextResponse.json({ error: 'Offline' }, { status: 500 });
  }

  const sig = request.headers.get('stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event: any;

  try {
    const raw = await request.text();
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(raw, sig, secret);
    } else {
      event = JSON.parse(raw);
    }
  } catch (err: any) {
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.mode === 'setup' && session.status === 'complete') {
      const sessionId = session.id;
      const already = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);
      if (already !== 1) {
        const meta = session.metadata || {};
        const email = String(meta.email || session.customer_email || '').trim().toLowerCase();
        const variant = String(meta.variant || '').trim();
        const size = String(meta.size || '50ml').trim();
        const shippingAddress = String(meta.address || '').trim();
        const customerId = typeof session.customer === 'string' ? session.customer : '';

        if (email && variant) {
          let paymentMethodId = '';
          let cardLast4 = '';
          let cardFingerprint = '';
          try {
            if (session.setup_intent) {
              const si = await stripe.setupIntents.retrieve(String(session.setup_intent), {
                expand: ['payment_method'],
              });
              const pm = si.payment_method as any;
              if (pm) {
                paymentMethodId = typeof pm === 'string' ? pm : pm.id;
                if (typeof pm !== 'string') {
                  cardLast4 = pm.card?.last4 || '';
                  cardFingerprint = pm.card?.fingerprint || '';
                }
              }
            }
          } catch {}

          const emailBlocked = await redis.sismember(emailBlockKey(variant, size), email);
          if (emailBlocked !== 1) {
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
          }
          await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}