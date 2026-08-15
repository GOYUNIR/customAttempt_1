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
  loadProducts,
  STORE_CONFIG_KEY,
  USERS_KEY,
  PROMO_CODES_KEY,
  promoUsedKey,
  poolKey,
  waitlistPoolKey,
  ENTRY_EMAIL_SENT_KEY,
} from '@/lib/server-config';
import { sendEntryConfirmedEmail } from '@/lib/email';
import { normalizeSiteBase } from '@/lib/url-utils';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';
import { getSiteUrl, fallbackSiteUrl } from '@/lib/env';
import { maskEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function siteUrlFromRequest(request: Request) {
  const env = getSiteUrl();
  if (env) return env;
  // The request host is the most truthful base for confirmation emails sent in
  // response to a customer action — never fall back to a stock example.com.
  try {
    const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
    if (forwardedHost) {
      const host = String(forwardedHost).split(',')[0].trim();
      const proto = request.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
      return normalizeSiteBase(`${proto}://${host}`);
    }
    const u = new URL(request.url);
    return normalizeSiteBase(`${u.protocol}//${u.host}`);
  } catch {
    return fallbackSiteUrl();
  }
}

async function resolvePromo(redis: any, rawCode: string, email: string) {
  const promoCode = String(rawCode || '').trim().toUpperCase();
  if (!promoCode) return { appliedPromo: undefined as string | undefined, discountPercent: 0 };
  try {
    const raw = await redis.hget(PROMO_CODES_KEY, promoCode);
    const promo = safeParseRedisItem<any>(raw);
    if (!promo || promo.active === false) {
      return { appliedPromo: undefined, discountPercent: 0 };
    }
    const maxPer = typeof promo.maxUsesPerEmail === 'number' ? promo.maxUsesPerEmail : 1;
    const self = promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === email;
    if (self) {
      return { appliedPromo: undefined, discountPercent: 0 };
    }
    if (maxPer > 0) {
      const used = await redis.sismember(promoUsedKey(promoCode), email);
      if (used === 1) {
        return { appliedPromo: undefined, discountPercent: 0 };
      }
    }
    const discountPercent = Math.min(
      50,
      Math.max(0, Number(promo.customerDiscountPercent ?? promo.discountPercent ?? 0) || 0),
    );
    return { appliedPromo: promoCode, discountPercent };
  } catch {
    return { appliedPromo: undefined, discountPercent: 0 };
  }
}

async function countActivePoolEntries(redis: any, variant: string, size: string, email: string) {
  try {
    const poolItems = await redis.lrange(poolKey(variant, size), 0, -1);
    let count = 0;
    for (const row of poolItems) {
      const parsed = safeParseRedisItem<any>(row);
      if (parsed && String(parsed.email || '').toLowerCase() === email.toLowerCase()) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/** Look up whether an email has a store account and its current rewards balance
 * (mirrors the store:users scan used by the Stripe webhook). */
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
    console.error('[confirm-setup] lookup rewards failed', e);
    return { hasAccount: false, rewardsBalance: 0 };
  }
}



/**
 * Lock a single raffle/waitlist entry into its pool using an already-completed
 * Stripe SETUP session. Shared by the single-product flow and the multi-item
 * raffle-cart flow (one setup session can secure several entries).
 */
async function lockOneEntry(opts: {
  redis: any;
  stripe: any;
  request: Request;
  email: string;
  variant: string;
  size: string;
  shippingAddress: string;
  orderRef: string;
  promoCode: string;
  customerId: string;
  paymentMethodId: string | null;
  cardLast4: string;
  cardFingerprint: string;
  entryType?: string;
  productId?: string;
  maxPerEmail: number;
}) {
  const {
    redis,
    request,
    email,
    variant,
    size,
    shippingAddress,
    orderRef,
    promoCode,
    customerId,
    paymentMethodId,
    cardLast4,
    cardFingerprint,
    entryType,
    productId,
    maxPerEmail,
  } = opts;

  const activeCount = await countActivePoolEntries(redis, variant, size, email);
  const blocked = await redis.sismember(emailBlockKey(variant, size), email);
  if ((blocked === 1 && activeCount > 0) || activeCount >= maxPerEmail) {
    return { created: false, duplicate: true, appliedPromo: undefined as string | undefined, discountPercent: 0, orderRef };
  }

  const { appliedPromo, discountPercent } = await resolvePromo(redis, promoCode, email);

  const entry: any = {
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
    promoCode: appliedPromo || undefined,
    discountPercent: appliedPromo && discountPercent > 0 ? discountPercent : undefined,
    registeredAt: new Date().toISOString(),
  };

  if (entryType === 'waitlist') {
    await redis.rpush(waitlistPoolKey(variant, size), JSON.stringify({ ...entry, registrationType: 'waitlist' }));
    await archiveEntry(redis, {
      email,
      variant,
      size,
      shippingAddress,
      id: customerId || 'n/a',
      registeredAt: entry.registeredAt,
      type: 'WAITLIST_JOINED',
      orderRef,
    } as any);
  } else {
    await redis.rpush(poolKey(variant, size), JSON.stringify(entry));
  }
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
    orderRef,
    ...(appliedPromo ? { promoCode: appliedPromo, discountPercent: discountPercent || undefined } : {}),
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
  let emailSent = false;
  try {
    const sent = await redis.sismember(ENTRY_EMAIL_SENT_KEY, emailDedupe);
    if (sent !== 1) {
      const liveProducts = await loadProducts(redis);
      const product = Object.values(liveProducts).find((p: any) => p.name === variant || p.id === productId) as any;
      const listPrice = product?.priceCategories?.find((category: any) => category.size === size)?.price || 0;
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
        listPrice: listPrice > 0 ? listPrice : undefined,
        orderRef,
        siteUrl: siteUrlFromRequest(request),
        hasAccount: userRewards.hasAccount || undefined,
        rewardsBalance: userRewards.hasAccount ? userRewards.rewardsBalance : undefined,
        purchasePointsPerDollar,
      });
      if ((emailResult as any)?.ok) {
        emailSent = true;
        await redis.sadd(ENTRY_EMAIL_SENT_KEY, emailDedupe);
      } else {
        // Never log the customer email or the full send result verbatim.
        console.error('[confirm-setup] entry email failed', maskEmail(email), (emailResult as any)?.error || 'send failed');
      }
      } else {
        emailSent = true;
      }
    } catch (e) {
      console.error('[confirm-setup] entry email error', e);
    }

    return { created: true, duplicate: false, appliedPromo, discountPercent, orderRef, emailSent };
  }

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'System offline.' }, { status: 500 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const sessionId = String(body?.sessionId || '');
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    const limited = await rateLimitedResponse('checkout_confirm_setup', request, 20, 60);
    if (limited) return limited;

    const already = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);
    if (already === 1) {
      let existingPromo = null;
      let existingDiscount = 0;
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const meta = session.metadata || {};
        if (meta.promoCode) {
          existingPromo = meta.promoCode;
          existingDiscount = Number(meta.discountPercent) || 0;
        }
      } catch {}
      return NextResponse.json({
        success: true,
        entryCreated: false,
        message: existingPromo
          ? `🎉 You're already locked in! Promo ${existingPromo} applied${existingDiscount > 0 ? ` (${existingDiscount}% off if selected)` : ''}. Good luck!`
          : "🎉 You're already locked in! Good luck with the allocation.",
        alreadyEntered: true,
        promoCode: existingPromo || null,
        discountPercent: existingDiscount || 0,
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent', 'setup_intent.payment_method'],
    });

    if (session.mode !== 'setup' || session.status !== 'complete') {
      return NextResponse.json({ error: 'Payment setup was not completed. Please try again.' }, { status: 400 });
    }

    const meta = session.metadata || {};
    const email = String(meta.email || session.customer_email || '').trim().toLowerCase();
    const shippingAddress = String(meta.address || '');
    const promoCode = String(meta.promoCode || meta.ref || '').trim().toUpperCase();
    const checkoutType = String(meta.checkoutType || 'single');

    if (!email) {
      return NextResponse.json({ error: 'Missing entry information.' }, { status: 400 });
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
    const customerId = typeof session.customer === 'string' ? session.customer : (session.customer as any)?.id || '';
    if (paymentMethodId && !cardLast4) {
      try {
        const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
        cardLast4 = String(pm.card?.last4 || '');
        cardFingerprint = String(pm.card?.fingerprint || cardFingerprint);
      } catch {}
    }
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
        console.error('[confirm-setup] attach payment method failed', e);
      }
    }

    const allProducts = await loadProducts(redis);
    const maxPerEmailFor = (productId: string) => {
      const p = allProducts[productId] || Object.values(allProducts).find((item: any) => item.name === String(meta.variant || ''));
      return Math.max(1, Number((p as any)?.maxPerEmail || 1));
    };

    // ── Multi-item raffle cart: one setup session secures every entry ────────
    if (checkoutType === 'raffle_cart') {
      let cartItems: Array<{ productId: string; variant: string; size: string; quantity: number; priceCents: number }> = [];
      try {
        cartItems = JSON.parse(String(meta.cartItems || '[]'));
      } catch {}
      if (cartItems.length === 0) {
        return NextResponse.json({ error: 'Missing cart entry information.' }, { status: 400 });
      }

      const locked: string[] = [];
      const duplicates: string[] = [];
      let firstPromo: string | null = null;
      let firstDiscount = 0;
      let orderRefIndex = 0;

      for (const line of cartItems) {
        const variant = String(line.variant || allProducts[line.productId]?.name || '');
        const size = String(line.size || 'Standard');
        if (!variant) continue;
        const qty = Math.max(1, Math.floor(Number(line.quantity || 1) || 1));
        const maxPerEmail = maxPerEmailFor(String(line.productId || ''));
        for (let i = 0; i < qty; i += 1) {
          orderRefIndex += 1;
          const lineOrderRef = formatOrderRef(String(meta.orderRef || ''))
            ? `${formatOrderRef(String(meta.orderRef || ''))}-${orderRefIndex}`
            : buildOrderRef(email, String(line.productId || variant), size);
          const result = await lockOneEntry({
            redis,
            stripe,
            request,
            email,
            variant,
            size,
            shippingAddress,
            orderRef: lineOrderRef,
            promoCode,
            customerId,
            paymentMethodId,
            cardLast4,
            cardFingerprint,
            entryType: String(meta.entryType || '').toLowerCase(),
            productId: String(line.productId || ''),
            maxPerEmail,
          });
          if (result.created) {
            locked.push(`${variant} (${size})`);
            if (result.appliedPromo) {
              firstPromo = result.appliedPromo;
              firstDiscount = result.discountPercent || firstDiscount;
            }
          } else if (result.duplicate) {
            duplicates.push(`${variant} (${size})`);
          }
        }
      }

      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);

      let message = '🎉 Your entries are locked in!';
      if (locked.length > 0) message = `🎉 ${locked.length} entr${locked.length === 1 ? 'y' : 'ies'} locked in for the allocation. Good luck!`;
      if (firstPromo) message += ` Promo ${firstPromo} applied${firstDiscount > 0 ? ` (${firstDiscount}% off if selected)` : ''}.`;
      if (duplicates.length > 0) message += ` Already entered: ${duplicates.join(', ')}.`;
      if (locked.length === 0 && duplicates.length > 0) message = `You're already entered for ${duplicates.join(', ')}. Pro tip: you can enter a different raffle.`;

      return NextResponse.json({
        success: true,
        entryCreated: locked.length > 0,
        message,
        email,
        address: shippingAddress,
        promoCode: firstPromo,
        discountPercent: firstDiscount,
        lockedCount: locked.length,
        duplicateCount: duplicates.length,
      });
    }

    // ── Single-product setup (legacy flow) ───────────────────────────────────
    const variant = String(meta.variant || '');
    const size = String(meta.size || 'Standard');
    const entryType = String(meta.entryType || '').toLowerCase();
    const orderRef = formatOrderRef(String(meta.orderRef || '')) || buildOrderRef(email, String(meta.productId || variant), size);

    if (!variant) {
      return NextResponse.json({ error: 'Missing entry information.' }, { status: 400 });
    }

    const maxPerEmail = maxPerEmailFor(String(meta.productId || ''));
    const result = await lockOneEntry({
      redis,
      stripe,
      request,
      email,
      variant,
      size,
      shippingAddress,
      orderRef,
      promoCode,
      customerId,
      paymentMethodId,
      cardLast4,
      cardFingerprint,
      entryType,
      productId: String(meta.productId || ''),
      maxPerEmail,
    });

    if (result.duplicate) {
      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
      return NextResponse.json({
        success: true,
        entryCreated: false,
        alreadyEntered: true,
        message: "🎉 You're already locked in for this drop — sit tight, we'll email you if you're selected. Good luck! Pro tip: you can enter a different raffle.",
      });
    }

    await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);

    let successMessage = "🎉 You're in! Your entry is locked for the allocation. Good luck!";
    if (result.appliedPromo) {
      successMessage += ` Promo ${result.appliedPromo} applied${result.discountPercent > 0 ? ` (${result.discountPercent}% off if selected)` : ''}.`;
    }
    if (!result.emailSent) {
      successMessage += " (We couldn't send a confirmation email, but your entry is saved.)";
    }

    return NextResponse.json({
      success: true,
      entryCreated: true,
      message: successMessage,
      email,
      address: shippingAddress,
      promoCode: result.appliedPromo || null,
      discountPercent: result.discountPercent || 0,
      clearPromo: !!result.appliedPromo,
    });
  } catch (err: any) {
    console.error('confirm-setup', err?.message || err);
    return NextResponse.json({ error: 'Could not confirm your entry. Please try again.' }, { status: 500 });
  }
}
