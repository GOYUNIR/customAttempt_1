import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, loadProducts, getLiveProductState, ARCHIVE_LEDGER_KEY, archiveEntry, safeParseRedisItem, emailBlockKey, PROMO_CODES_KEY, promoUsedKey, promoPendingKey, poolKey, STORE_CONFIG_KEY } from '@/lib/server-config';
import { buildOrderRef, formatOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { validateShippingAddress } from '@/lib/address-validation';
import { isConfiguredPrice } from '@/lib/storefront-config';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
const PROMO_PENDING_TTL_SECONDS = 10 * 60;

function getCheckoutMode(product: any): 'RAFFLE' | 'FCFS' {
  const mode = String(product?.checkoutMode || '').toUpperCase();
  if (mode === 'FCFS') return 'FCFS';
  if (mode === 'RAFFLE') return 'RAFFLE';
  if (product?.isRaffle === false) return 'FCFS';
  return 'RAFFLE';
}

/** Read the admin-configured order-ref prefix (`store:config.refPrefix`,
 * fallback 'GU') so refs built here match what the admin portal shows. */
async function getRefPrefix(redis: any): Promise<string> {
  try {
    const rawCfg = await redis.get(STORE_CONFIG_KEY);
    const cfg = safeParseRedisItem<any>(rawCfg) || {};
    return normalizeRefPrefix(cfg?.refPrefix || 'GU');
  } catch {
    return 'GU';
  }
}

async function countChargedByEmail(redis: any, email: string, variant: string, size: string) {
  const rows = await redis.lrange(ARCHIVE_LEDGER_KEY, 0, -1);
  let count = 0;
  for (const row of rows) {
    try {
      const parsed = typeof row === 'string' ? JSON.parse(row) : row;
      if (!parsed) continue;
      if (String(parsed.type || '') !== 'WINNER_CHARGED') continue;
      if (String(parsed.email || '').toLowerCase() !== email) continue;
      if (String(parsed.variant || '') !== variant) continue;
      if (String(parsed.size || '') !== size) continue;
      count += 1;
    } catch {}
  }
  return count;
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline' }, { status: 500 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { productId, size, email, address, promoCode, ref } = body;
    const requestedMode = String(body?.mode || '').toLowerCase();

    if (!productId || !size || !email || !address) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
    }

    const addrError = validateShippingAddress(String(address || ''));
    if (addrError) {
      return NextResponse.json({ error: addrError }, { status: 400 });
    }

    const limited = await rateLimitedResponse('checkout', request, 20, 60);
    if (limited) return limited;

    const allProducts = await loadProducts(redis);
    const product = allProducts[productId];
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const priceCat = (product.priceCategories || []).find((c: any) => c.size === size);
    if (!priceCat || !isConfiguredPrice(priceCat.price)) {
      return NextResponse.json({ error: 'Price not set for this size' }, { status: 400 });
    }
    const basePriceCents = Math.round(priceCat.price * 100);
    const productSlug = String(product.slug || product.id);
    const variant = String(product.name || product.id);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const checkoutMode = getCheckoutMode(product);
    const usesWaitlist = requestedMode === 'waitlist' || (checkoutMode === 'FCFS' && (product.isArchived === true || product.isUpcoming === true));
    const maxPerEmail = Math.max(1, Number(product.maxPerEmail || 1));
    const refPrefix = await getRefPrefix(redis);
    const orderRef = buildOrderRef(normalizedEmail, variant, String(size), refPrefix);
    let priceCents = basePriceCents;
    const normalizedPromo = String(promoCode || ref || '').trim().toUpperCase();

    // ── Block duplicate raffle/waitlist entries BEFORE Stripe is launched ─────
    // Previously a customer could complete a second card setup in Stripe and
    // only get told they were already entered afterwards. Now we check the pool
    // up-front and return a clear "you're already in" message without ever
    // creating a Stripe session or showing a false success.
    if (checkoutMode === 'RAFFLE' || usesWaitlist) {
      let alreadyEnteredCount = 0;
      try {
        const poolItems = await redis.lrange(poolKey(variant, size), 0, -1);
        for (const row of poolItems) {
          const parsed = safeParseRedisItem<any>(row);
          if (parsed && String(parsed.email || '').toLowerCase() === normalizedEmail) alreadyEnteredCount += 1;
        }
      } catch {}
      const blocked = await redis.sismember(emailBlockKey(variant, size), normalizedEmail);
      // A customer may re-enter once a draw completes and the pool is reset for a
      // new cycle. A stale fraud-block flag from the previous cycle must NOT block
      // a fresh entry when the pool no longer holds this email — so only block when
      // the email actually has an ACTIVE entry (or has hit the per-email cap).
      const hasActiveEntry = alreadyEnteredCount > 0;
      if (hasActiveEntry && (blocked === 1 || alreadyEnteredCount >= maxPerEmail)) {
        // Reuse the ORIGINAL entry's order ref (if any) so the ledger REF for
        // the DUPLICATE_BLOCKED row matches the original entry instead of a
        // newly generated one.
        let originalRef = orderRef;
        try {
          const poolItems = await redis.lrange(poolKey(variant, size), 0, -1);
          for (const row of poolItems) {
            const parsed = safeParseRedisItem<any>(row);
            if (parsed && String(parsed.email || '').toLowerCase() === normalizedEmail && formatOrderRef(String(parsed.orderRef || ''), refPrefix)) {
              originalRef = formatOrderRef(String(parsed.orderRef || ''), refPrefix) || originalRef;
              break;
            }
          }
        } catch {}
        await archiveEntry(redis, {
          email: normalizedEmail,
          variant,
          size: String(size),
          shippingAddress: String(address || '').trim(),
          id: 'n/a',
          registeredAt: new Date().toISOString(),
          type: 'DUPLICATE_BLOCKED',
          orderRef: originalRef,
        } as any);
        return NextResponse.json({
          error: `You're already entered for ${variant} (${size}). Good luck! Pro tip: you can enter a different raffle.`,
          alreadyEntered: true,
          code: 'DUPLICATE_BLOCKED',
        });
      }
    }

    if (normalizedPromo && checkoutMode === 'FCFS') {
      const rawPromo = await redis.hget(PROMO_CODES_KEY, normalizedPromo);
      const promo = safeParseRedisItem<any>(rawPromo);
      if (!promo || promo.active === false) {
        return NextResponse.json({ error: 'Invalid or inactive promo code.' }, { status: 400 });
      }
      if (promo.giftable !== true && promo.issuedForEmail && String(promo.issuedForEmail).toLowerCase() !== normalizedEmail) {
        return NextResponse.json({ error: 'This code is reserved for a different account.' }, { status: 403 });
      }
      if (promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === normalizedEmail) {
        return NextResponse.json({ error: 'Promoters cannot use their own code.' }, { status: 403 });
      }
      if (Number(promo.maxUsesTotal || 0) > 0 && Number(promo.uses || 0) >= Number(promo.maxUsesTotal || 0)) {
        return NextResponse.json({ error: 'This code has been fully claimed.' }, { status: 409 });
      }
      if (Number(promo.maxUsesPerEmail || 0) > 0) {
        const used = await redis.sismember(promoUsedKey(normalizedPromo), normalizedEmail);
        if (used === 1) {
          return NextResponse.json({ error: 'This code has already been used with this email address.' }, { status: 409 });
        }
      }
      const pendingKey = promoPendingKey(normalizedPromo, normalizedEmail);
      const pending = await redis.get(pendingKey);
      if (pending) {
        return NextResponse.json({ error: 'This code already has a checkout in progress for this email. Finish that checkout or wait a bit before trying again.' }, { status: 409 });
      }
      const eligibleProductSlugs = Array.isArray(promo.eligibleProductSlugs) ? promo.eligibleProductSlugs.map(String) : [];
      const eligibleSizes = Array.isArray(promo.eligibleSizes) ? promo.eligibleSizes.map(String) : [];
      const minimumOrderSubtotalCents = Math.max(0, Number(promo.minimumOrderSubtotalCents || 0));
      if (eligibleProductSlugs.length > 0 && !eligibleProductSlugs.includes(productSlug)) {
        return NextResponse.json({ error: 'This code only works on selected full-size items.' }, { status: 409 });
      }
      if (eligibleSizes.length > 0 && !eligibleSizes.includes(String(size))) {
        return NextResponse.json({ error: 'This code only works on selected sizes.' }, { status: 409 });
      }
      if (minimumOrderSubtotalCents > 0 && basePriceCents < minimumOrderSubtotalCents) {
        return NextResponse.json({ error: `This code unlocks on orders over $${(minimumOrderSubtotalCents / 100).toFixed(2)}.` }, { status: 409 });
      }
      const fixedDiscountCents = Math.max(0, Number(promo.fixedDiscountCents || 0));
      const percentDiscount = Math.min(50, Math.max(0, Number(promo.customerDiscountPercent ?? promo.discountPercent ?? 0) || 0));
      if (fixedDiscountCents > 0) {
        priceCents = Math.max(50, basePriceCents - Math.min(basePriceCents - 50, fixedDiscountCents));
      } else if (percentDiscount > 0) {
        priceCents = Math.max(50, Math.round(basePriceCents * (1 - percentDiscount / 100)));
      }
    } else if (normalizedPromo && checkoutMode === 'RAFFLE') {
      // Promo codes now work on raffle entries too (the % discount is applied
      // "if selected" — the entry stores promoCode + discountPercent, and the
      // draw/webhook applies it at charge time). We only validate that the code
      // is active, belongs to this email, and has quota left.
      const rawPromo = await redis.hget(PROMO_CODES_KEY, normalizedPromo);
      const promo = safeParseRedisItem<any>(rawPromo);
      if (promo) {
        if (promo.active === false) {
          return NextResponse.json({ error: 'Invalid or inactive promo code.' }, { status: 400 });
        }
        if (promo.issuedForEmail && String(promo.issuedForEmail).toLowerCase() !== normalizedEmail) {
          return NextResponse.json({ error: 'This code is reserved for a different account.' }, { status: 403 });
        }
        if (promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === normalizedEmail) {
          return NextResponse.json({ error: 'Promoters cannot use their own code.' }, { status: 403 });
        }
        if (Number(promo.maxUsesTotal || 0) > 0 && Number(promo.uses || 0) >= Number(promo.maxUsesTotal || 0)) {
          return NextResponse.json({ error: 'This code has been fully claimed.' }, { status: 409 });
        }
        if (Number(promo.maxUsesPerEmail || 0) > 0) {
          const used = await redis.sismember(promoUsedKey(normalizedPromo), normalizedEmail);
          if (used === 1) {
            return NextResponse.json({ error: 'This code has already been used with this email address.' }, { status: 409 });
          }
        }
      }
    }

    if (checkoutMode === 'FCFS' && !usesWaitlist) {
      const live = await getLiveProductState(redis, product, String(size));
      if (!live || live.inventoryRemaining <= 0) {
        return NextResponse.json({ error: 'Sold out for this size.' }, { status: 409 });
      }
      const chargedCount = await countChargedByEmail(redis, normalizedEmail, variant, String(size));
      if (chargedCount >= maxPerEmail) {
        return NextResponse.json({ error: `Purchase limit reached (${maxPerEmail} per email).` }, { status: 409 });
      }
    }

    await archiveEntry(redis, {
      email: normalizedEmail,
      variant,
      size: String(size),
      shippingAddress: String(address || '').trim(),
      id: 'intent',
      registeredAt: new Date().toISOString(),
      type: 'INTENT_STARTED',
      orderRef,
    } as any);

    const origin = (() => {
      const forwardedProto = request.headers.get('x-forwarded-proto');
      const forwardedHost = request.headers.get('x-forwarded-host');
      const host = forwardedHost || request.headers.get('host') || 'localhost:3000';
      const protocol = forwardedProto || (host.includes('localhost') ? 'http' : 'https');
      return `${protocol}://${host}`;
    })();

    // Get or create customer
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { initialShippingAddress: address },
      });
    }

    if (checkoutMode === 'RAFFLE' || usesWaitlist) {
      const session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customer.id,
        payment_method_types: ['card'],
        success_url: `${origin}/${productSlug}?setup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/${productSlug}?setup=cancel`,
        metadata: {
          productId: String(productId),
          productSlug,
          variant: String(product.name || ''),
          size: String(size),
          email: normalizedEmail,
          address: String(address),
          maxPerEmail: String(maxPerEmail),
          orderRef,
          promoCode: normalizedPromo,
          ref: String(ref || promoCode || '').trim().toUpperCase(),
          entryType: usesWaitlist ? 'waitlist' : 'raffle',
        },
      });
      return NextResponse.json({ url: session.url, sessionId: session.id });
    } else {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customer.id,
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              unit_amount: priceCents,
              product_data: {
                name: `${product.name} - ${size}`,
                description: product.tagline || product.desc || undefined,
              },
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/${productSlug}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/${productSlug}?purchase=cancel`,
        metadata: {
          productId: String(productId),
          productSlug,
          variant: String(product.name || ''),
          size: String(size),
          email: normalizedEmail,
          address: String(address),
          maxPerEmail: String(maxPerEmail),
          orderRef,
          promoCode: normalizedPromo,
          ref: String(ref || promoCode || '').trim().toUpperCase(),
          entryType: usesWaitlist ? 'waitlist' : 'direct',
        },
        payment_intent_data: {
          receipt_email: email,
          metadata: {
            productId: String(productId),
            productSlug,
            variant: String(product.name || ''),
            size: String(size),
            email: normalizedEmail,
            address: String(address),
            maxPerEmail: String(maxPerEmail),
            orderRef,
            promoCode: normalizedPromo,
            ref: String(ref || promoCode || '').trim().toUpperCase(),
          },
        },
      });
      if (normalizedPromo) {
        await redis.set(promoPendingKey(normalizedPromo, normalizedEmail), session.id, { ex: PROMO_PENDING_TTL_SECONDS });
      }
      return NextResponse.json({ url: session.url, sessionId: session.id });
    }
  } catch (err: any) {
    console.error('[checkout] failed', err?.message || err);
    return NextResponse.json({ error: 'Checkout could not be started. Please try again.' }, { status: 500 });
  }
}