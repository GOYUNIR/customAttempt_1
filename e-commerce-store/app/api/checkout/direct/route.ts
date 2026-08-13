import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  getLiveProductState,
  saveLiveState,
  archiveEntry,
  ArchiveRecord,
  loadProducts, // new helper to fetch product from Redis
  resolveStripePriceId,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getAvailableSizes, isConfiguredPrice } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline.' }, { status: 500 });
    }

    const body = await request.json();
    const { productId, size, email, shippingAddress, paymentMethodId, promoCode, customerId } = body;

    if (!productId || !size || !email || !shippingAddress || !paymentMethodId) {
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    // Fetch the product from Redis – this gives us the live priceCategories.
    const allProducts = await loadProducts(redis);
    const product = allProducts[productId];
    if (!product) {
      return NextResponse.json({ error: 'Product not found.' }, { status: 404 });
    }

    const availableSizes = getAvailableSizes(GOYUNIR_STORE_SUITE);
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

    const stripeId = resolveStripePriceId(category.stripeId);
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
      description: `GOYUNIR direct: ${product.name} (${size})`,
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
      orderRef: `DIRECT-${Date.now().toString(36)}`,
      promoCode: promoCode || undefined,
    };
    await archiveEntry(redis, archiveRecord);

    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      amount: priceCents / 100,
    });
  } catch (err: any) {
    console.error('[direct/route] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}