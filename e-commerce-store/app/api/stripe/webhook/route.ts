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
  safeParseRedisItem,
} from '@/lib/server-config';
import { sendEntryConfirmedEmail } from '@/lib/email';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getProductPrice } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';
const ENTRY_EMAIL_SENT_KEY = 'email:entry_confirmed';

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

function siteUrlFromEnv() {
  const env = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;
  if (env) return env.replace(/\/$/, '');
  return 'https://custom-attempt-1.vercel.app';
}

async function resolvePromo(
  redis: NonNullable<ReturnType<typeof createRedisClient>>,
  rawCode: string,
  email: string,
) {
  const promoCode = String(rawCode || '')
    .trim()
    .toUpperCase();
  if (!promoCode) {
    return { appliedPromo: undefined as string | undefined, discountPercent: 0 };
  }

  try {
    const raw = await redis.hget(PROMOS_KEY, promoCode);
    const promo = safeParseRedisItem<any>(raw);
    if (!promo || promo.active === false) {
      console.warn('[webhook] promo not found or inactive', promoCode);
      return { appliedPromo: undefined, discountPercent: 0 };
    }

    const maxPer = typeof promo.maxUsesPerEmail === 'number' ? promo.maxUsesPerEmail : 1;
    const self = promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === email;
    if (self) {
      console.warn('[webhook] self-promo blocked', promoCode, email);
      return { appliedPromo: undefined, discountPercent: 0 };
    }
    if (maxPer > 0) {
      const used = await redis.sismember(usedEmailsKey(promoCode), email);
      if (used === 1) {
        console.warn('[webhook] promo already used by email', promoCode, email);
        return { appliedPromo: undefined, discountPercent: 0 };
      }
    }

    const discountPercent = Math.min(
      50,
      Math.max(0, Number(promo.customerDiscountPercent ?? promo.discountPercent ?? 0) || 0),
    );
    return { appliedPromo: promoCode, discountPercent };
  } catch (e) {
    console.error('[webhook] promo lookup failed', e);
    return { appliedPromo: undefined, discountPercent: 0 };
  }
}

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
    const rawBody = await request.text();
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } else {
      event = JSON.parse(rawBody);
    }
  } catch (err: any) {
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.mode === 'setup' && session.status === 'complete') {
      const sessionId = session.id;
      const already = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);

      if (already === 1) {
        return NextResponse.json({ received: true, skipped: 'already_processed' });
      }

      const meta = session.metadata || {};
      const email = String(meta.email || session.customer_email || '')
        .trim()
        .toLowerCase();
      const variant = String(meta.variant || '').trim();
      const size = String(meta.size || '50ml').trim();
      const shippingAddress = String(meta.address || '').trim();
      const customerId = typeof session.customer === 'string' ? session.customer : '';
      const rawPromo = String(meta.promoCode || meta.ref || '');

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
          const { appliedPromo, discountPercent } = await resolvePromo(redis, rawPromo, email);

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
            promoCode: appliedPromo || undefined,
            discountPercent: appliedPromo && discountPercent > 0 ? discountPercent : undefined,
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
            ...(appliedPromo
              ? { promoCode: appliedPromo, discountPercent: discountPercent || undefined }
              : {}),
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

          const emailDedupe = `${variant}:${size}:${email}`;
          try {
            const sent = await redis.sismember(ENTRY_EMAIL_SENT_KEY, emailDedupe);
            if (sent !== 1) {
              const product = GOYUNIR_STORE_SUITE.productCatalog.find(
                (p) => p.name === variant || p.id === variant,
              );
              const listPrice = product ? getProductPrice(product, size) : undefined;
              await sendEntryConfirmedEmail({
                to: email,
                product: variant,
                size,
                address: shippingAddress,
                promoCode: appliedPromo,
                discountPercent: discountPercent || undefined,
                listPrice,
                siteUrl: siteUrlFromEnv(),
              });
              await redis.sadd(ENTRY_EMAIL_SENT_KEY, emailDedupe);
            }
          } catch (e) {
            console.error('[webhook] entry email', e);
          }

          console.log('[webhook] entry locked', {
            email,
            variant,
            size,
            promoCode: appliedPromo || null,
            discountPercent: discountPercent || 0,
          });
        }

        await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
      }
    }
  }

  return NextResponse.json({ received: true });
}