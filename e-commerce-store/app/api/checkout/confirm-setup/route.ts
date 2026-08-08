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
} from '@/lib/server-config';
import { sendEntryConfirmedEmail } from '@/lib/email';
import { buildOrderRef, formatOrderRef } from '@/lib/order-ref';

export const dynamic = 'force-dynamic';

const PROMOS_KEY = 'config:promos';
const ENTRY_EMAIL_SENT_KEY = 'email:entry_confirmed';

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

function siteUrlFromRequest(request: Request) {
  const env = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL;
  if (env) return env.replace(/\/$/, '');
  try {
    const u = new URL(request.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://goyunir.com';
  }
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

    // Check if already processed
    const already = await redis.sismember(PROCESSED_SESSIONS_KEY, sessionId);
    if (already === 1) {
      // Try to get the promo from the session metadata
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
    const email = String(meta.email || session.customer_email || '')
      .trim()
      .toLowerCase();
    const variant = String(meta.variant || '');
    const size = String(meta.size || 'Standard');
    const shippingAddress = String(meta.address || '');
    const promoCode = String(meta.promoCode || meta.ref || '')
      .trim()
      .toUpperCase();
    const orderRef = formatOrderRef(String(meta.orderRef || '')) || buildOrderRef(email, String(meta.productId || variant), size);

    if (!email || !variant) {
      return NextResponse.json({ error: 'Missing entry information.' }, { status: 400 });
    }

    // Get payment method details
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

    // Check if email is already entered
    const blocked = await redis.sismember(emailBlockKey(variant, size), email);
    if (blocked === 1) {
      await redis.sadd(PROCESSED_SESSIONS_KEY, sessionId);
      await archiveEntry(redis, {
        email,
        variant,
        size,
        shippingAddress,
        id: customerId || 'n/a',
        registeredAt: new Date().toISOString(),
        type: 'DUPLICATE_BLOCKED',
      });
      return NextResponse.json({
        success: true,
        entryCreated: false,
        alreadyEntered: true,
        message: "🎉 You're already locked in for this drop — sit tight, we'll email you if you're selected.",
      });
    }

    // Validate and apply promo code
    let appliedPromo: string | undefined = promoCode || undefined;
    let discountPercent = 0;
    if (promoCode) {
      try {
        const raw = await redis.hget(PROMOS_KEY, promoCode);
        const promo = safeParseRedisItem<any>(raw);
        if (!promo || promo.active === false) {
          console.warn('[confirm-setup] promo not found or inactive', promoCode);
          appliedPromo = undefined;
        } else {
          const maxPer = typeof promo.maxUsesPerEmail === 'number' ? promo.maxUsesPerEmail : 1;
          const self = promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === email;
          if (self) {
            console.warn('[confirm-setup] self-promo blocked', promoCode, email);
            appliedPromo = undefined;
          } else if (maxPer > 0) {
            const used = await redis.sismember(usedEmailsKey(promoCode), email);
            if (used === 1) {
              console.warn('[confirm-setup] promo already used by email', promoCode, email);
              appliedPromo = undefined;
            }
          }
          if (appliedPromo) {
            discountPercent = Math.min(
              50,
              Math.max(
                0,
                Number(promo.customerDiscountPercent ?? promo.discountPercent ?? 0) || 0,
              ),
            );
          }
        }
      } catch (e) {
        console.error('[confirm-setup] promo lookup failed', e);
        appliedPromo = undefined;
      }
    }

    // Create the entry
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
      promoCode: appliedPromo || undefined,
      discountPercent: appliedPromo && discountPercent > 0 ? discountPercent : undefined,
      registeredAt: new Date().toISOString(),
    };

    // Save to Redis
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
      orderRef,
      ...(appliedPromo
        ? { promoCode: appliedPromo, discountPercent: discountPercent || undefined }
        : {}),
    } as any);

    // Track promo usage
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

    // Send confirmation email
    const emailDedupe = `${variant}:${size}:${email}`;
    let emailSent = false;
    try {
      const sent = await redis.sismember(ENTRY_EMAIL_SENT_KEY, emailDedupe);
      if (sent !== 1) {
        const liveProducts = await loadProducts(redis);
        const product = Object.values(liveProducts).find((p: any) => p.name === variant || p.id === meta.productId) as any;
        const listPrice = product?.priceCategories?.find((category: any) => category.size === size)?.price || 0;
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
        });
        if ((emailResult as any)?.ok) {
          emailSent = true;
          await redis.sadd(ENTRY_EMAIL_SENT_KEY, emailDedupe);
        } else {
          console.error('[confirm-setup] entry email failed', email, emailResult);
        }
      } else {
        emailSent = true;
      }
    } catch (e) {
      console.error('[confirm-setup] entry email error', e);
    }

    // Build success message
    let successMessage = '🎉 You\'re in! Your entry is locked for the allocation. Good luck!';
    if (appliedPromo) {
      successMessage += ` Promo ${appliedPromo} applied${discountPercent > 0 ? ` (${discountPercent}% off if selected)` : ''}.`;
    }
    if (!emailSent) {
      successMessage += ' (We couldn\'t send a confirmation email, but your entry is saved.)';
    }

    // Clear the promo from session storage (will be handled client-side)
    // We return the promo info so the client can clear it

    return NextResponse.json({
      success: true,
      entryCreated: true,
      message: successMessage,
      email,
      address: shippingAddress,
      promoCode: appliedPromo || null,
      discountPercent: discountPercent || 0,
      clearPromo: !!appliedPromo, // Tell client to clear the promo display
    });
  } catch (err: any) {
    console.error('confirm-setup', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}