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
  loadProducts,
  getLiveProductState,
  saveLiveState,
} from '@/lib/server-config';
import { sendEntryConfirmedEmail } from '@/lib/email';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';
const ENTRY_EMAIL_SENT_KEY = 'email:entry_confirmed';
const PRODUCTS_KEY = 'store:products';

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

function pendingPromoKey(code: string, email: string) {
  return `promo:pending:${code}:${email}`;
}

function siteUrlFromEnv() {
  const env = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;
  if (env) return env.replace(/\/$/, '');
  return 'https://goyunir.com';
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
    const sessionId = session.id;
    const already = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);

    if (already === 1) {
      return NextResponse.json({ received: true, skipped: 'already_processed' });
    }

    if (session.mode === 'setup' && session.status === 'complete') {
      const meta = session.metadata || {};
      const email = String(meta.email || session.customer_email || '')
        .trim()
        .toLowerCase();
      const variant = String(meta.variant || '').trim();
      const size = String(meta.size || 'Standard').trim();
      const shippingAddress = String(meta.address || '').trim();
      const customerId = typeof session.customer === 'string' ? session.customer : '';
      const rawPromo = String(meta.promoCode || meta.ref || '');
      const maxPerEmail = Math.max(1, Number(meta.maxPerEmail || 1));
      const orderRef = formatOrderRef(String(meta.orderRef || '')) || buildOrderRef(email, String(meta.productId || variant), size);

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

        const poolKey = `drop_pool:${variant}:${size}`;
        const existingEntries = await redis.lrange(poolKey, 0, -1);
        const activeCountForEmail = existingEntries.reduce((count: number, row: any) => {
          const parsed = safeParseRedisItem<any>(row);
          if (String(parsed?.email || '').toLowerCase() === email) return count + 1;
          return count;
        }, 0);

        const emailBlocked = await redis.sismember(emailBlockKey(variant, size), email);
        const blockedByLegacyOneEntryRule = emailBlocked === 1 && maxPerEmail <= 1;
        const blockedByLimit = activeCountForEmail >= maxPerEmail;
        if (!blockedByLegacyOneEntryRule && !blockedByLimit) {
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
            orderRef,
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
            orderRef,
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
              const liveProducts = await loadProducts(redis);
              const product = Object.values(liveProducts).find((p: any) => p.name === variant || p.id === meta.productId);
              const category = (product as any)?.priceCategories?.find((item: any) => item.size === size);
              const listPrice = category?.price;
              await sendEntryConfirmedEmail({
                to: email,
                product: variant,
                size,
                address: shippingAddress,
                promoCode: appliedPromo,
                discountPercent: discountPercent || undefined,
                listPrice,
                orderRef,
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
        if (blockedByLimit) {
          await archiveEntry(redis, {
            email,
            variant,
            size,
            shippingAddress,
            id: customerId || 'n/a',
            registeredAt: new Date().toISOString(),
            type: 'ADMIN_NOTE',
            orderRef,
          } as any);
        }

        await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
      }
    }

    if (session.mode === 'payment' && session.status === 'complete') {
      const meta = session.metadata || {};
      const email = String(meta.email || session.customer_email || '').trim().toLowerCase();
      const productId = String(meta.productId || '').trim();
      const variant = String(meta.variant || '').trim();
      const size = String(meta.size || 'Standard').trim();
      const shippingAddress = String(meta.address || '').trim();
      const checkoutType = String(meta.checkoutType || 'single');
      const appliedPromo = String(meta.promoCode || meta.ref || '').trim().toUpperCase();
      const orderRef = formatOrderRef(String(meta.orderRef || '')) || buildOrderRef(email, String(meta.productId || variant), size);

      const allProducts = await loadProducts(redis);
      if (checkoutType === 'cart') {
        let cartItems: any[] = [];
        try {
          cartItems = JSON.parse(String(meta.cartItems || '[]'));
        } catch {}
        for (const item of cartItems) {
          const thisProduct = allProducts[String(item.productId || '')] as any;
          if (!thisProduct) continue;
          const thisSize = String(item.size || 'Standard');
          const qty = Math.max(1, Number(item.quantity || 1));
          const priceCents = Math.max(0, Number(item.priceCents || 0));
          const live = await getLiveProductState(redis, thisProduct, thisSize);
          live.inventoryRemaining = Math.max(0, Number(live.inventoryRemaining || 0) - qty);
          live.salesCompleted = (live.salesCompleted || 0) + qty;
          await saveLiveState(redis, live);
          if (live.inventoryRemaining <= 0) {
            thisProduct.soldOutAt = thisProduct.soldOutAt || new Date().toISOString();
            await redis.hset(PRODUCTS_KEY, { [thisProduct.id]: JSON.stringify(thisProduct) });
          }

          for (let i = 0; i < qty; i += 1) {
            await archiveEntry(redis, {
              email,
              variant: thisProduct.name,
              size: thisSize,
              shippingAddress,
              id: typeof session.customer === 'string' ? session.customer : 'n/a',
              registeredAt: new Date().toISOString(),
              type: 'WINNER_CHARGED',
              shippingStatus: 'PENDING_FULFILLMENT',
              amountCents: priceCents,
              promoCode: appliedPromo || undefined,
              orderRef: orderRef ? `${orderRef}-${i + 1}` : `DIRECT-${session.id}-${i + 1}`,
            } as any);
          }
        }
      } else {
        const product = (allProducts[productId] || Object.values(allProducts).find((item: any) => item.name === variant)) as any;
        if (product && email) {
          const live = await getLiveProductState(redis, product, size);
          if (live.inventoryRemaining > 0) {
            live.inventoryRemaining -= 1;
          }
          live.salesCompleted = (live.salesCompleted || 0) + 1;
          await saveLiveState(redis, live);
          if (live.inventoryRemaining <= 0) {
            product.soldOutAt = product.soldOutAt || new Date().toISOString();
            await redis.hset(PRODUCTS_KEY, { [product.id]: JSON.stringify(product) });
          }

          await archiveEntry(redis, {
            email,
            variant: product.name,
            size,
            shippingAddress,
            id: typeof session.customer === 'string' ? session.customer : 'n/a',
            registeredAt: new Date().toISOString(),
            type: 'WINNER_CHARGED',
            shippingStatus: 'PENDING_FULFILLMENT',
            amountCents: Number(session.amount_total || 0),
            promoCode: appliedPromo || undefined,
            orderRef: orderRef || `DIRECT-${session.id}`,
          } as any);
        }
      }

      if (appliedPromo) {
        try {
          await redis.sadd(usedEmailsKey(appliedPromo), email);
          await redis.del(pendingPromoKey(appliedPromo, email));
          await redis.del(pendingPromoKey(appliedPromo, email));
          const raw = await redis.hget(PROMOS_KEY, appliedPromo);
          const promo = safeParseRedisItem<any>(raw);
          if (promo) {
            promo.uses = (Number(promo.uses) || 0) + 1;
            await redis.hset(PROMOS_KEY, { [appliedPromo]: JSON.stringify(promo) });
          }
        } catch (e) {
          console.error('[webhook] payment promo accounting failed', e);
        }
      }

      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
    }
  }

  return NextResponse.json({ received: true });
}