import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  getProductOverride,
  getLiveProductState,
  saveLiveState,
  archiveEntry,
  ArchiveRecord,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getAvailableSizes } from '@/lib/storefront-config';

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

    const productDefinition = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.id === productId);
    if (!productDefinition) {
      return NextResponse.json({ error: 'Product not found.' }, { status: 404 });
    }

    const availableSizes = getAvailableSizes(GOYUNIR_STORE_SUITE);
    if (!availableSizes.includes(size)) {
      return NextResponse.json({ error: 'Invalid size.' }, { status: 400 });
    }

    // Get live state (inventory, etc.)
    const live = await getLiveProductState(redis, productDefinition, size);
    if (!live || live.inventoryRemaining <= 0) {
      return NextResponse.json({ error: 'Sold out.' }, { status: 400 });
    }

    // Get the Stripe price ID from the product definition (these are set in admin via overrides)
    // We also allow a fallback to the config value, but config should be 0 if not set.
    const stripePriceId = size === '100ml' ? productDefinition.stripeId100ml : productDefinition.stripeId50ml;
    if (!stripePriceId || stripePriceId === 'price_placeholder_50' || stripePriceId === 'price_placeholder_100') {
      return NextResponse.json({
        error: 'Stripe price ID not configured for this product/size. Please set it in the admin portal.'
      }, { status: 400 });
    }

    // Get price – use override if exists, otherwise fallback to product definition (should be 0)
    const override = await getProductOverride(redis, productDefinition.id);
    const basePrice = size === '100ml'
      ? (override?.price100ml ?? productDefinition.price100ml)
      : (override?.price50ml ?? productDefinition.price50ml);
    if (!basePrice || basePrice <= 0) {
      return NextResponse.json({
        error: 'Price not configured for this product/size. Set it in admin.'
      }, { status: 400 });
    }
    const priceCents = Math.round(basePrice * 100);

    // Create or use existing Stripe customer
    let stripeCustomerId = customerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { initialShippingAddress: shippingAddress },
      });
      stripeCustomerId = customer.id;
    }

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: priceCents,
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: false,
      confirm: true,
      receipt_email: email,
      description: `GOYUNIR direct: ${productDefinition.name} (${size})`,
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
      variant: productDefinition.name,
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