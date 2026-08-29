import { NextResponse } from 'next/server';
import {
  createRedisClient,
  getLiveProductState,
  saveLiveState,
  archiveEntry,
  ArchiveRecord,
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

    // Create or use existing Stripe customer
    let stripeCustomerId = customerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { initialShippingAddress: shippingAddress },
      });
      stripeCustomerId = customer.id;
    }

    // Create PaymentIntent using the actual Stripe Price ID from the category
    const paymentIntent = await stripe.paymentIntents.create({
      amount: priceCents,
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: false,
      confirm: true,
      receipt_email: email,
      description: `${product.name} (${size})`,
    });

    if (paymentIntent.status !== 'succeeded') {
      return NextResponse.json({ error: 'Payment not successful.' }, { status: 400 });
    }

    // Deduct inventory
    live.inventoryRemaining -= 1;
    live.salesCompleted = (live.salesCompleted || 0) + 1;
    await saveLiveState(redis, live);

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