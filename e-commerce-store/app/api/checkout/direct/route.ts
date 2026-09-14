import { NextResponse } from 'next/server';
import {
  createRedisClient,
  getLiveProductState,
  saveLiveState,
  archiveEntry,
  ArchiveRecord,
  ARCHIVE_LEDGER_KEY,
  loadProducts, // new helper to fetch product from Redis
  safeParseRedisItem,
  STORE_CONFIG_KEY,
} from '@/lib/server-config';
import { resolveStripeClient } from '@/services/payment/factory';
import { resolveStripePriceIdWithSettings } from '@/services/config/platform-settings';
import { buildOrderRef, normalizeRefPrefix } from '@/lib/order-ref';
import { isConfiguredPrice } from '@/lib/storefront-config';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { withRedisLock } from '@/lib/redis-lock';

/** Same anti-scalping check `checkout/route.ts` enforces before creating a
 * Stripe Checkout Session — this direct-charge path was missing it entirely,
 * letting a stored payment method buy unlimited units of a "N per customer"
 * drop. */
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

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = await resolveStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline.' }, { status: 500 });
    }

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { productId, size, email, shippingAddress, paymentMethodId, promoCode, customerId } = body;

    if (!productId || !size || !email || !shippingAddress || !paymentMethodId) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }
    if (!isValidEmail(email)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
    }
    const normalizedEmail = String(email).trim().toLowerCase();

    const limited = await rateLimitedResponse('checkout_direct', request, 10, 60);
    if (limited) return limited;

    const refPrefix = await getRefPrefix(redis);

    // Fetch the product from Redis – this gives us the live priceCategories.
    const allProducts = await loadProducts(redis);
    const product = allProducts[productId];
    if (!product) {
      return NextResponse.json({ error: 'Product not found.' }, { status: 404 });
    }

    // Also check if the size exists in the product's priceCategories
    const priceCategories = product.priceCategories || [];
    const category = priceCategories.find((cat: any) => cat.size === size);
    if (!category) {
      return NextResponse.json({ error: `Size "${size}" not configured for this product.` }, { status: 400 });
    }

    // Price and Stripe ID come directly from the priceCategories (no separate overrides needed)
    const basePrice = category.price;
    if (!isConfiguredPrice(basePrice)) {
      return NextResponse.json({ error: `Price not set for size "${size}". Set it in admin.` }, { status: 400 });
    }
    const priceCents = Math.round(basePrice * 100);

    const stripeId = await resolveStripePriceIdWithSettings(category.stripeId);
    if (!stripeId || stripeId.startsWith('price_placeholder') || stripeId === '') {
      return NextResponse.json({ error: `Stripe price ID not set for size "${size}". Set it in admin or via STRIPE_PRODUCT_ID.` }, { status: 400 });
    }

    // Get live inventory state
    const live = await getLiveProductState(redis, product, size);
    if (!live || live.inventoryRemaining <= 0) {
      return NextResponse.json({ error: 'Sold out.' }, { status: 400 });
    }

    // Anti-scalping cap — same rule `checkout/route.ts` enforces.
    const maxPerEmail = Math.max(1, Number((product as any).maxPerEmail || 1));
    const chargedCount = await countChargedByEmail(redis, normalizedEmail, product.name, String(size));
    if (chargedCount >= maxPerEmail) {
      return NextResponse.json({ error: `Purchase limit reached (${maxPerEmail} per email).` }, { status: 409 });
    }

    // Create or use existing Stripe customer
    let stripeCustomerId = customerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { initialShippingAddress: shippingAddress },
      });
      stripeCustomerId = customer.id;
    }

    // Create PaymentIntent using the actual Stripe Price ID from the category.
    // An idempotency key means a client retry (double-tap, network blip) of
    // the SAME attempt reuses this key and Stripe dedupes it into one charge.
    // Bucketed to a 30s window on the stable inputs so it's deterministic
    // across retries of one attempt but doesn't block a later, separate
    // purchase of the same product/size by the same customer.
    const idempotencyKey = `direct:${normalizedEmail}:${productId}:${size}:${paymentMethodId}:${Math.floor(Date.now() / 30_000)}`;
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: priceCents,
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: false,
        confirm: true,
        receipt_email: email,
        description: `${product.name} (${size})`,
      },
      { idempotencyKey },
    );

    if (paymentIntent.status !== 'succeeded') {
      return NextResponse.json({ error: 'Payment not successful.' }, { status: 400 });
    }

    // Deduct inventory. The card is already charged at this point, so a
    // contended lock still falls back to an unlocked (best-effort) decrement
    // rather than silently leaving stock counts wrong.
    const decrementInventory = async () => {
      const inner = await getLiveProductState(redis, product, size);
      inner.inventoryRemaining = Math.max(0, Number(inner.inventoryRemaining || 0) - 1);
      inner.salesCompleted = (inner.salesCompleted || 0) + 1;
      await saveLiveState(redis, inner);
      return inner;
    };
    const lockResult = await withRedisLock(redis, `inventory:${product.id}:${size}`, decrementInventory);
    if (!lockResult.ok) console.warn('[checkout/direct] inventory lock contended, falling back to unlocked decrement', product.id, size);
    if (!lockResult.ok) await decrementInventory();

    // Archive the sale
    const customerIdForArchive = typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : (paymentIntent.customer?.id ?? 'n/a');

    const archiveRecord: ArchiveRecord = {
      email,
      variant: product.name,
      size,
      shippingAddress,
      id: customerIdForArchive,
      registeredAt: new Date().toISOString(),
      type: 'WINNER_CHARGED',
      shippingStatus: 'PENDING_FULFILLMENT',
      amountCents: priceCents,
      orderRef: buildOrderRef(email, String(productId), String(size), refPrefix),
      promoCode: promoCode || undefined,
    };
    await archiveEntry(redis, archiveRecord);

    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      amount: priceCents / 100,
    });
  } catch (err: any) {
    console.error('[direct/route] Error:', err?.message || err);
    return NextResponse.json({ error: 'Payment could not be completed. Please try again.' }, { status: 500 });
  }
}