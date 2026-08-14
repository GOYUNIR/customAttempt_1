import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  loadProducts,
  getLiveProductState,
  ARCHIVE_LEDGER_KEY,
  safeParseRedisItem,
  emailBlockKey,
} from '@/lib/server-config';
import { buildOrderRef } from '@/lib/order-ref';
import { validateShippingAddress } from '@/lib/address-validation';
import { isConfiguredPrice } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';
const PROMOS_KEY = 'config:promos';
const PROMO_PENDING_TTL_SECONDS = 10 * 60;

function usedEmailsKey(code: string) {
  return `promo:used_emails:${code}`;
}

function pendingPromoKey(code: string, email: string) {
  return `promo:pending:${code}:${email}`;
}

type CartInputItem = {
  productId: string;
  size: string;
  quantity?: number;
};

function getCheckoutMode(product: any): 'RAFFLE' | 'FCFS' {
  const mode = String(product?.checkoutMode || '').toUpperCase();
  if (mode === 'FCFS') return 'FCFS';
  if (mode === 'RAFFLE') return 'RAFFLE';
  if (product?.isRaffle === false) return 'FCFS';
  return 'RAFFLE';
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

async function countActivePoolEntries(redis: any, variant: string, size: string, email: string) {
  try {
    const poolItems = await redis.lrange(`drop_pool:${variant}:${size}`, 0, -1);
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



export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline' }, { status: 500 });
    }

    const body = await request.json();
    const email = String(body?.email || '').trim().toLowerCase();
    const address = String(body?.address || '').trim();
    const promoCode = String(body?.promoCode || body?.ref || '').trim().toUpperCase();
    const cart = Array.isArray(body?.items) ? (body.items as CartInputItem[]) : [];

    if (!email || !address || cart.length === 0) {
      return NextResponse.json({ error: 'Missing checkout details.' }, { status: 400 });
    }

    const addrError = validateShippingAddress(address);
    if (addrError) {
      return NextResponse.json({ error: addrError }, { status: 400 });
    }

    // Resolve the deployment origin for Stripe success/cancel URLs. In a Next.js
    // route handler `origin` is NOT a global (that's browser-only), so derive it
    // from the forwarded headers (Vercel) or the Host header (localhost/dev).
    const origin = (() => {
      const forwardedProto = request.headers.get('x-forwarded-proto');
      const forwardedHost = request.headers.get('x-forwarded-host');
      const host = forwardedHost || request.headers.get('host') || 'example.com';
      const protocol = forwardedProto || (host.includes('localhost') ? 'http' : 'https');
      return `${protocol}://${host}`;
    })();

    const allProducts = await loadProducts(redis);
    const aggregate = new Map<string, { productId: string; size: string; quantity: number }>();
    for (const item of cart) {
      const productId = String(item?.productId || '').trim();
      const size = String(item?.size || '').trim();
      if (!productId || !size) continue;
      const key = `${productId}:${size}`;
      const prev = aggregate.get(key);
      const qty = Math.max(1, Math.floor(Number(item?.quantity || 1) || 1));
      if (prev) prev.quantity += qty;
      else aggregate.set(key, { productId, size, quantity: qty });
    }

    const normalizedItems = [...aggregate.values()];
    if (normalizedItems.length === 0) {
      return NextResponse.json({ error: 'Cart is empty.' }, { status: 400 });
    }

    // Partition the cart into FCFS (charged now) and RAFFLE (card setup, charged if selected).
    const fcfsLines: Array<{ product: any; size: string; quantity: number; baseUnitPriceCents: number; baseLineTotalCents: number; eligible: boolean }> = [];
    const raffleLines: Array<{ product: any; size: string; quantity: number; baseUnitPriceCents: number }> = [];

    for (const item of normalizedItems) {
      const product = allProducts[item.productId];
      if (!product) {
        return NextResponse.json({ error: 'A cart item no longer exists.' }, { status: 404 });
      }
      const category = (product.priceCategories || []).find((c: any) => String(c.size) === item.size);
      if (!category || !isConfiguredPrice(category.price)) {
        return NextResponse.json({ error: `Price missing for ${product.name} (${item.size}).` }, { status: 400 });
      }
      const variant = String(product.name || product.id);
      const maxPerEmail = Math.max(1, Number(product.maxPerEmail || 1));
      if (item.quantity > maxPerEmail) {
        return NextResponse.json({ error: `${product.name} limit is ${maxPerEmail} per email.` }, { status: 409 });
      }

      if (getCheckoutMode(product) === 'FCFS') {
        const priorCharges = await countChargedByEmail(redis, email, variant, item.size);
        if (priorCharges + item.quantity > maxPerEmail) {
          return NextResponse.json({ error: `${product.name} limit reached for this email.` }, { status: 409 });
        }
        const live = await getLiveProductState(redis, product, item.size);
        if (!live || live.inventoryRemaining < item.quantity) {
          return NextResponse.json({ error: `${product.name} (${item.size}) does not have enough inventory.` }, { status: 409 });
        }
        const priceCents = Math.round(Number(category.price || 0) * 100);
        fcfsLines.push({
          product,
          size: item.size,
          quantity: item.quantity,
          baseUnitPriceCents: priceCents,
          baseLineTotalCents: priceCents * item.quantity,
          eligible: true,
        });
      } else {
        // Raffle lines: block duplicates BEFORE creating a setup session. A stale
        // fraud block from a previous draw cycle must not block a fresh entry, so
        // we only block when this email actually has an ACTIVE entry in the pool.
        const activeCount = await countActivePoolEntries(redis, variant, item.size, email);
        const blocked = await redis.sismember(emailBlockKey(variant, item.size), email);
        if (activeCount > 0 && (blocked === 1 || activeCount + item.quantity > maxPerEmail)) {
          return NextResponse.json({ error: `You're already entered for ${product.name} (${item.size}). Good luck! Pro tip: you can enter a different raffle.`, alreadyEntered: true, code: 'DUPLICATE_BLOCKED' }, { status: 409 });
        }
        raffleLines.push({
          product,
          size: item.size,
          quantity: item.quantity,
          baseUnitPriceCents: Math.round(Number(category.price || 0) * 100),
        });
      }
    }


    // ── FCFS payment session (charged immediately) ───────────────────────────
    let fcfsUrl: string | undefined;
    let fcfsPromoNormalized = '';
    if (fcfsLines.length > 0) {
      const line_items: any[] = [];
      const summaryItems: Array<{ productId: string; variant: string; size: string; quantity: number; priceCents: number }> = [];

      const promoSubtotalCents = fcfsLines.reduce((sum, line) => sum + line.baseLineTotalCents, 0);
      const normalizedPromo = promoCode;
      fcfsPromoNormalized = normalizedPromo;

      if (normalizedPromo) {
        const rawPromo = await redis.hget(PROMOS_KEY, normalizedPromo);
        const promo = safeParseRedisItem<any>(rawPromo);
        if (!promo || promo.active === false) {
          return NextResponse.json({ error: 'Invalid or inactive promo code.' }, { status: 400 });
        }
        if (promo.giftable !== true && promo.issuedForEmail && String(promo.issuedForEmail).toLowerCase() !== email) {
          return NextResponse.json({ error: 'This code is reserved for a different account.' }, { status: 403 });
        }
        if (promo.promoterEmail && String(promo.promoterEmail).toLowerCase() === email) {
          return NextResponse.json({ error: 'Promoters cannot use their own code.' }, { status: 403 });
        }
        if (Number(promo.maxUsesTotal || 0) > 0 && Number(promo.uses || 0) >= Number(promo.maxUsesTotal || 0)) {
          return NextResponse.json({ error: 'This code has been fully claimed.' }, { status: 409 });
        }
        if (Number(promo.maxUsesPerEmail || 0) > 0) {
          const used = await redis.sismember(usedEmailsKey(normalizedPromo), email);
          if (used === 1) {
            return NextResponse.json({ error: 'This code has already been used with this email address.' }, { status: 409 });
          }
        }
        const pendingKey = pendingPromoKey(normalizedPromo, email);
        const pending = await redis.get(pendingKey);
        if (pending) {
          return NextResponse.json({ error: 'This code already has a checkout in progress for this email. Finish that checkout or wait a bit before trying again.' }, { status: 409 });
        }
        const eligibleProductSlugs = Array.isArray(promo.eligibleProductSlugs) ? promo.eligibleProductSlugs.map(String) : [];
        const eligibleSizes = Array.isArray(promo.eligibleSizes) ? promo.eligibleSizes.map(String) : [];
        const minimumOrderSubtotalCents = Math.max(0, Number(promo.minimumOrderSubtotalCents || 0));
        if (minimumOrderSubtotalCents > 0 && promoSubtotalCents < minimumOrderSubtotalCents) {
          return NextResponse.json({ error: `This code unlocks on orders over $${(minimumOrderSubtotalCents / 100).toFixed(2)}.` }, { status: 409 });
        }
        for (const line of fcfsLines) {
          line.eligible = (eligibleProductSlugs.length === 0 || eligibleProductSlugs.includes(String(line.product.slug || '')))
            && (eligibleSizes.length === 0 || eligibleSizes.includes(String(line.size)));
        }
        if (!fcfsLines.some((line) => line.eligible)) {
          return NextResponse.json({ error: 'This code only works on selected full-size items.' }, { status: 409 });
        }

        const eligibleSubtotalCents = fcfsLines.reduce((sum, line) => sum + (line.eligible ? line.baseLineTotalCents : 0), 0);
        const fixedDiscountCents = Math.max(0, Number(promo.fixedDiscountCents || 0));
        const percentDiscount = Math.min(50, Math.max(0, Number(promo.customerDiscountPercent ?? promo.discountPercent ?? 0) || 0));
        let remainingDiscountCents = fixedDiscountCents > 0
          ? Math.min(Math.max(0, eligibleSubtotalCents - 50), fixedDiscountCents)
          : 0;

        fcfsLines.forEach((line, index) => {
          let lineTotal = line.baseLineTotalCents;
          if (line.eligible) {
            if (fixedDiscountCents > 0 && eligibleSubtotalCents > 0) {
              const proportional = index === fcfsLines.length - 1
                ? remainingDiscountCents
                : Math.min(remainingDiscountCents, Math.round((line.baseLineTotalCents / eligibleSubtotalCents) * fixedDiscountCents));
              lineTotal = Math.max(50 * line.quantity, lineTotal - proportional);
              remainingDiscountCents -= proportional;
            } else if (percentDiscount > 0) {
              lineTotal = Math.max(50 * line.quantity, Math.round(lineTotal * (1 - percentDiscount / 100)));
            }
          }
          const unitAmount = Math.max(50, Math.round(lineTotal / line.quantity));
          line_items.push({
            price_data: {
              currency: 'usd',
              unit_amount: unitAmount,
              product_data: {
                name: `${line.product.name} - ${line.size}`,
                description: line.product.tagline || line.product.desc || undefined,
              },
            },
            quantity: line.quantity,
          });
          summaryItems.push({
            productId: String(line.product.id),
            variant: String(line.product.name || line.product.id),
            size: line.size,
            quantity: line.quantity,
            priceCents: unitAmount,
          });
        });
      } else {
        fcfsLines.forEach((line) => {
          line_items.push({
            price_data: {
              currency: 'usd',
              unit_amount: line.baseUnitPriceCents,
              product_data: {
                name: `${line.product.name} - ${line.size}`,
                description: line.product.tagline || line.product.desc || undefined,
              },
            },
            quantity: line.quantity,
          });
          summaryItems.push({
            productId: String(line.product.id),
            variant: String(line.product.name || line.product.id),
            size: line.size,
            quantity: line.quantity,
            priceCents: line.baseUnitPriceCents,
          });
        });
      }

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

      const returnSlug = summaryItems[0]?.variant
        ? (allProducts[summaryItems[0].productId]?.slug || Object.values(allProducts)[0]?.slug || 'catalog')
        : (Object.values(allProducts)[0]?.slug || 'catalog');
      const orderRef = buildOrderRef(email, summaryItems[0].productId, summaryItems[0].size);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customer.id,
        payment_method_types: ['card'],
        line_items,
        success_url: `${origin}/${returnSlug}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/${returnSlug}?purchase=cancel`,
        metadata: {
          checkoutType: 'cart',
          email,
          address,
          cartItems: JSON.stringify(summaryItems),
          promoCode: fcfsPromoNormalized,
          ref: fcfsPromoNormalized,
          orderRef,
        },
      });
      if (fcfsPromoNormalized) {
        await redis.set(pendingPromoKey(fcfsPromoNormalized, email), session.id, { ex: PROMO_PENDING_TTL_SECONDS });
      }
      fcfsUrl = session.url || undefined;
    }

    // ── RAFFLE setup session (one card setup that secures every raffle entry) ─
    let raffleUrl: string | undefined;
    if (raffleLines.length > 0) {
      const raffleSummaryItems = raffleLines.map((line) => ({
        productId: String(line.product.id),
        variant: String(line.product.name || line.product.id),
        size: line.size,
        quantity: line.quantity,
        priceCents: line.baseUnitPriceCents,
      }));
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
      const returnSlug = raffleSummaryItems[0]?.variant
        ? (allProducts[raffleSummaryItems[0].productId]?.slug || Object.values(allProducts)[0]?.slug || 'catalog')
        : (Object.values(allProducts)[0]?.slug || 'catalog');
      const orderRef = buildOrderRef(email, raffleSummaryItems[0].productId, raffleSummaryItems[0].size);
      const session = await stripe.checkout.sessions.create({
        mode: 'setup',
        customer: customer.id,
        payment_method_types: ['card'],
        success_url: `${origin}/${returnSlug}?setup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/${returnSlug}?setup=cancel`,
        metadata: {
          checkoutType: 'raffle_cart',
          email,
          address,
          cartItems: JSON.stringify(raffleSummaryItems),
          promoCode,
          ref: promoCode,
          orderRef,
        },
      });
      raffleUrl = session.url || undefined;
    }

    const url = raffleUrl || fcfsUrl;
    if (!url) {
      return NextResponse.json({ error: 'Unable to start checkout.' }, { status: 500 });
    }

    return NextResponse.json({
      url,
      paymentUrl: raffleUrl && fcfsUrl ? fcfsUrl : undefined,
      raffleCount: raffleLines.length,
      fcfsCount: fcfsLines.length,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
