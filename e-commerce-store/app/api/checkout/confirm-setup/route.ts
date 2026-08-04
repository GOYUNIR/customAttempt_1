import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  archiveEntry,
  emailBlockKey,
  cardBlockKey,
  poolStatField,
  POOL_STATS_KEY,
  PROCESSED_SESSIONS_KEY,
  cleanupMatchingIntent,
} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

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
    let paymentMethodId: string | null = null;
    let cardLast4 = '';
    let cardFingerprint = '';

    if (typeof setupIntent === 'object' && setupIntent) {
      const pm = setupIntent.payment_method;
      if (typeof pm === 'string') {
        paymentMethodId = pm;
      } else if (pm && typeof pm === 'object') {
        paymentMethodId = pm.id || null;
        cardLast4 = String(pm.card?.last4 || '');
        cardFingerprint = String(pm.card?.fingerprint || '');
      }
    }

    const customerId =
      typeof session.customer === 'string' ? session.customer : (session.customer as any)?.id || '';

    if (paymentMethodId && !cardLast4) {
      try {
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        cardLast4 = String(pm.card?.last4 || '');
        cardFingerprint = String(pm.card?.fingerprint || cardFingerprint);
      } catch {}
    }

    const blocked = await redis.sismember(emailBlockKey(variant, size), email);
    if (blocked === 1) {
      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
      return NextResponse.json({
        success: true,
        alreadyEntered: true,
        message: 'Already registered for this allocation.',
      });
    }

    // Promo: block if this email already used this code (when maxUsesPerEmail > 0)
    let appliedPromo: string | undefined = promoCode || undefined;
    if (promoCode) {
      try {
        const raw = await redis.hget(PROMOS_KEY, promoCode);
        const promo = safeParseRedisItem<any>(raw);
        if (!promo || promo.active === false) {
          appliedPromo = undefined;
        } else {
          const maxPer =
            typeof promo.maxUsesPerEmail === 'number' ? promo.maxUsesPerEmail : 1;
          const self =
            promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === email;
          if (self) {
            appliedPromo = undefined;
          } else if (maxPer > 0) {
            const used = await redis.sismember(usedEmailsKey(promoCode), email);
            if (used === 1) appliedPromo = undefined;
          }
        }
      } catch {
        appliedPromo = undefined;
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
      promoCode: appliedPromo,
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
      ...(appliedPromo ? { promoCode: appliedPromo } : {}),
    } as any);

    if (appliedPromo) {
      try {
        await redis.sadd(usedEmailsKey(appliedPromo), email);
        const raw = await redis.hget(PROMOS_KEY, appliedPromo);
        const promo = safeParseRedisItem<any>(raw);
        if (promo) {
          promo.uses = (promo.uses || 0) + 1;
          await redis.hset(PROMOS_KEY, { [appliedPromo]: JSON.stringify(promo) });
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