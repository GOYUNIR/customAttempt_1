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
  STORE_CONFIG_KEY,
  USERS_KEY,
  PRODUCTS_KEY,
  PROMO_CODES_KEY,
  promoUsedKey,
  promoPendingKey,
  poolKey,
  ENTRY_EMAIL_SENT_KEY,
} from '@/lib/server-config';
import { sendEntryConfirmedEmail } from '@/lib/email';
import { buildOrderRef, formatOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { getSiteUrl, fallbackSiteUrl } from '@/lib/env';
import { isValidEmail, clampLength, maskEmail } from '@/lib/validation';

export const dynamic = 'force-dynamic';

function siteUrlFromEnv() {
  return getSiteUrl() || fallbackSiteUrl();
}

/**
 * Every paid purchase earns rewards points for the account owner (if they have
 * an account). Rate is configurable in /admin → Settings → Rewards & Points.
 */
async function awardPurchasePoints(redis: any, email: string, amountCents: number) {
  try {
    if (!email || Number(amountCents) <= 0) return;
    const rawConfig = await redis.get(STORE_CONFIG_KEY);
    const config = safeParseRedisItem<any>(rawConfig) || {};
    const rate = Math.max(0, Number(config?.rewards?.purchasePointsPerDollar) || 10);
    if (rate <= 0) return;
    const pointsEarned = Math.floor((Number(amountCents) / 100) * rate);
    if (pointsEarned <= 0) return;
    const raw = await redis.hgetall(USERS_KEY);
    if (!raw) return;
    for (const [k, v] of Object.entries(raw)) {
      const u = safeParseRedisItem<any>(v);
      if (u && String(u.email || '').toLowerCase() === String(email || '').toLowerCase()) {
        u.rewards = Math.max(0, Number(u.rewards || 0)) + pointsEarned;
        await redis.hset(USERS_KEY, { [k]: JSON.stringify(u) });
        break;
      }
    }
  } catch (e) {
    console.error('[webhook] award points failed', e);
  }
}

/** Look up whether an email has a store account and its current rewards balance
 * (mirrors the store:users scan in awardPurchasePoints). */
async function lookupUserRewards(redis: any, email: string): Promise<{ hasAccount: boolean; rewardsBalance: number }> {
  try {
    if (!email) return { hasAccount: false, rewardsBalance: 0 };
    const raw = await redis.hgetall(USERS_KEY);
    if (!raw) return { hasAccount: false, rewardsBalance: 0 };
    for (const [, v] of Object.entries(raw)) {
      const u = safeParseRedisItem<any>(v);
      if (u && String(u.email || '').toLowerCase() === String(email || '').toLowerCase()) {
        return { hasAccount: true, rewardsBalance: Math.max(0, Number(u.rewards || 0)) };
      }
    }
    return { hasAccount: false, rewardsBalance: 0 };
  } catch (e) {
    console.error('[webhook] lookup rewards failed', e);
    return { hasAccount: false, rewardsBalance: 0 };
  }
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
    const raw = await redis.hget(PROMO_CODES_KEY, promoCode);
    const promo = safeParseRedisItem<any>(raw);
    if (!promo || promo.active === false) {
      console.warn('[webhook] promo not found or inactive', promoCode);
      return { appliedPromo: undefined, discountPercent: 0 };
    }

    const maxPer = typeof promo.maxUsesPerEmail === 'number' ? promo.maxUsesPerEmail : 1;
    const self = promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === email;
    if (self) {
      console.warn('[webhook] self-promo blocked', promoCode, maskEmail(email));
      return { appliedPromo: undefined, discountPercent: 0 };
    }
    if (maxPer > 0) {
      const used = await redis.sismember(promoUsedKey(promoCode), email);
      if (used === 1) {
        console.warn('[webhook] promo already used by email', promoCode, maskEmail(email));
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

  // Admin-configured order-ref prefix (store:config.refPrefix, fallback 'GU').
  // Every ref built/normalized below uses it so legacy GY-/GOY- refs are
  // re-labelled to the NEW prefix and new refs are born with it.
  let refPrefix = 'GU';
  try {
    const rawCfg = await redis.get(STORE_CONFIG_KEY);
    const cfg = safeParseRedisItem<any>(rawCfg) || {};
    refPrefix = normalizeRefPrefix(cfg?.refPrefix || 'GU');
  } catch {
    refPrefix = 'GU';
  }

  const sig = request.headers.get('stripe-signature');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  // Unverified parsing is ONLY allowed in local development with an explicit
  // opt-in flag — never in production, and never just because a header is
  // missing. Forging a checkout.session.completed event must be impossible.
  const allowUnverified = process.env.NODE_ENV !== 'production' && process.env.DEV_WEBHOOK_BYPASS === '1';
  let event: any;

  try {
    const rawBody = await request.text();
    // Stripe webhook payloads are a few KB; anything larger is not a Stripe
    // event. Guard before any parse so a giant body can't pin CPU/memory.
    if (rawBody.length > 1_000_000) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    if (secret && sig) {
      event = stripe.webhooks.constructEvent(rawBody, sig, secret);
    } else if (allowUnverified) {
      event = JSON.parse(rawBody);
    } else {
      return NextResponse.json(
        { error: 'Webhook signature verification required' },
        { status: 400 },
      );
    }
  } catch (err: any) {
    // Never echo the underlying error to the caller — log it server-side only
    // (signature errors can leak payload details / internals).
    console.error('[webhook] event verification failed', err?.message || err);
    return NextResponse.json({ error: 'Webhook Error' }, { status: 400 });
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
      const shippingAddress = clampLength(meta.address, 500).trim();
      const customerId = typeof session.customer === 'string' ? session.customer : '';
      const rawPromo = String(meta.promoCode || meta.ref || '').slice(0, 40);
      const checkoutType = String(meta.checkoutType || 'single').slice(0, 20);

      // Defense-in-depth: never let a malformed session payload write junk into
      // the pools/ledger, even though signature verification is now mandatory.
      if (!isValidEmail(email)) {
        console.warn('[webhook] setup session rejected: invalid email', maskEmail(email));
        await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
        return NextResponse.json({ received: true, skipped: 'invalid_payload' });
      }

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

      // Surface the saved card + address in the Stripe Customer Portal.
      if (paymentMethodId && customerId) {
        try {
          await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: paymentMethodId },
            ...(shippingAddress
              ? {
                  address: { line1: shippingAddress },
                  shipping: { name: email, address: { line1: shippingAddress } },
                }
              : {}),
          });
        } catch (e) {
          console.error('[webhook] attach payment method failed', e);
        }
      }

      // Build the (variant, size, orderRef, maxPerEmail) lines this session
      // secures. A `raffle_cart` setup session carries cartItems JSON and its
      // meta.variant is EMPTY — the webhook must expand every cart line here,
      // otherwise the whole branch is skipped and NO ledger row / confirmation
      // email is ever written for multi-item cart checkouts.
      const allProducts = await loadProducts(redis);
      const lines: Array<{ variant: string; size: string; orderRef: string; productId: string; maxPerEmail: number }> = [];
      if (checkoutType === 'raffle_cart') {
        let cartItems: any[] = [];
        try {
          const rawCart = String(meta.cartItems || '[]');
          if (rawCart.length <= 50_000) cartItems = JSON.parse(rawCart);
        } catch {}
        if (cartItems.length === 0) {
          console.warn('[webhook] raffle_cart setup session rejected: empty cartItems', maskEmail(email));
          await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
          return NextResponse.json({ received: true, skipped: 'invalid_payload' });
        }
        let orderRefIndex = 0;
        for (const item of cartItems) {
          const variant = clampLength(String(item.variant || allProducts[String(item.productId || '')]?.name || ''), 200).trim();
          const size = clampLength(String(item.size || 'Standard'), 50).trim();
          if (!variant || !size) continue;
          const qty = Math.max(1, Math.floor(Number(item.quantity || 1) || 1));
          const product = allProducts[String(item.productId || '')] as any;
          const maxPerEmail = Math.max(1, Number(product?.maxPerEmail || meta.maxPerEmail || 1));
          const baseRef = formatOrderRef(String(meta.orderRef || ''), refPrefix) || buildOrderRef(email, String(item.productId || variant), size, refPrefix);
          for (let i = 0; i < qty; i += 1) {
            orderRefIndex += 1;
            lines.push({
              variant,
              size,
              orderRef: `${baseRef}-${orderRefIndex}`,
              productId: String(item.productId || ''),
              maxPerEmail,
            });
          }
        }
      } else {
        const variant = clampLength(meta.variant, 200).trim();
        const size = clampLength(meta.size || 'Standard', 50).trim();
        if (!variant || !size) {
          console.warn('[webhook] setup session rejected: invalid variant/size', maskEmail(email));
          await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
          return NextResponse.json({ received: true, skipped: 'invalid_payload' });
        }
        const maxPerEmail = Math.max(1, Number(meta.maxPerEmail || 1));
        const orderRef = formatOrderRef(String(meta.orderRef || ''), refPrefix) || buildOrderRef(email, String(meta.productId || variant), size, refPrefix);
        lines.push({ variant, size, orderRef, productId: String(meta.productId || ''), maxPerEmail });
      }

      for (const line of lines) {
        const { variant, size, orderRef, productId, maxPerEmail } = line;

        const pool = poolKey(variant, size);
        const existingEntries = await redis.lrange(pool, 0, -1);
        const activeCountForEmail = existingEntries.reduce((count: number, row: any) => {
          const parsed = safeParseRedisItem<any>(row);
          if (String(parsed?.email || '').toLowerCase() === email) return count + 1;
          return count;
        }, 0);

        const emailBlocked = await redis.sismember(emailBlockKey(variant, size), email);
        // Only treat the fraud-block as a duplicate when this email actually holds
        // an ACTIVE entry — after a draw resets the pool, a stale block from the
        // previous cycle must not block a fresh entry in the new cycle.
        const hasActiveEntry = activeCountForEmail > 0;
        const blockedByLegacyOneEntryRule = emailBlocked === 1 && maxPerEmail <= 1 && hasActiveEntry;
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

          await redis.rpush(poolKey(variant, size), JSON.stringify(entry));
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
              await redis.sadd(promoUsedKey(appliedPromo), email);
              const raw = await redis.hget(PROMO_CODES_KEY, appliedPromo);
              const promo = safeParseRedisItem<any>(raw);
              if (promo) {
                promo.uses = (promo.uses || 0) + 1;
                await redis.hset(PROMO_CODES_KEY, { [appliedPromo]: JSON.stringify(promo) });
              }
            } catch {}
          }

          const emailDedupe = `${variant}:${size}:${email}`;
          try {
            const sent = await redis.sismember(ENTRY_EMAIL_SENT_KEY, emailDedupe);
            if (sent !== 1) {
              const product = Object.values(allProducts).find((p: any) => p.name === variant || p.id === productId);
              const category = (product as any)?.priceCategories?.find((item: any) => item.size === size);
              const listPrice = category?.price;
              const userRewards = await lookupUserRewards(redis, email);
              const rawStoreConfig = await redis.get(STORE_CONFIG_KEY);
              const storeConfig = safeParseRedisItem<any>(rawStoreConfig) || {};
              const purchasePointsPerDollar = Math.max(0, Number(storeConfig?.rewards?.purchasePointsPerDollar) || 10);
              const emailResult = await sendEntryConfirmedEmail({
                to: email,
                product: variant,
                size,
                address: shippingAddress,
                promoCode: appliedPromo,
                discountPercent: discountPercent || undefined,
                listPrice,
                orderRef,
                siteUrl: siteUrlFromEnv(),
                hasAccount: userRewards.hasAccount || undefined,
                rewardsBalance: userRewards.hasAccount ? userRewards.rewardsBalance : undefined,
                purchasePointsPerDollar,
              });
              // Only dedupe when the email ACTUALLY went out — a skipped/failed
              // send (e.g. RESEND_API_KEY missing) must be retried by the
              // confirm-setup repair path instead of being swallowed forever.
              if (emailResult?.ok === true) {
                await redis.sadd(ENTRY_EMAIL_SENT_KEY, emailDedupe);
              } else {
                console.error('[webhook] entry email failed', maskEmail(email), emailResult?.error || 'send failed');
              }
            }
          } catch (e) {
            console.error('[webhook] entry email', e);
          }

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
      }

      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
    }

    if (session.mode === 'payment' && session.status === 'complete') {
      const meta = session.metadata || {};
      const email = String(meta.email || session.customer_email || '').trim().toLowerCase();
      const productId = clampLength(meta.productId, 200).trim();
      const variant = clampLength(meta.variant, 200).trim();
      const size = clampLength(meta.size || 'Standard', 50).trim();
      const shippingAddress = clampLength(meta.address, 500).trim();
      const checkoutType = String(meta.checkoutType || 'single').slice(0, 20);
      const appliedPromo = String(meta.promoCode || meta.ref || '').trim().toUpperCase().slice(0, 40);
      const orderRef = formatOrderRef(String(meta.orderRef || ''), refPrefix) || buildOrderRef(email, String(meta.productId || variant), size, refPrefix);

      // Same defense-in-depth as the setup path: junk payloads never reach the
      // ledger/inventory accounting.
      if (!isValidEmail(email)) {
        console.warn('[webhook] payment session rejected: invalid email', maskEmail(email));
        await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
        return NextResponse.json({ received: true, skipped: 'invalid_payload' });
      }

      const allProducts = await loadProducts(redis);
      if (checkoutType === 'cart') {
        let cartItems: any[] = [];
        try {
          const rawCart = String(meta.cartItems || '[]');
          if (rawCart.length <= 50_000) cartItems = JSON.parse(rawCart);
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
          await awardPurchasePoints(redis, email, priceCents * qty);
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
          await awardPurchasePoints(redis, email, Number(session.amount_total || 0));
        }
      }

      if (appliedPromo) {
        try {
          await redis.sadd(promoUsedKey(appliedPromo), email);
          await redis.del(promoPendingKey(appliedPromo, email));
          const raw = await redis.hget(PROMO_CODES_KEY, appliedPromo);
          const promo = safeParseRedisItem<any>(raw);
          if (promo) {
            promo.uses = (Number(promo.uses) || 0) + 1;
            await redis.hset(PROMO_CODES_KEY, { [appliedPromo]: JSON.stringify(promo) });
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