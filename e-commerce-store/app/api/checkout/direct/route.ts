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
import { getProductPrice, getAvailableSizes } from '@/lib/storefront-config';

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
    const { productId, size, email, shippingAddress, paymentMethodId, promoCode } = body;

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

    // Get the Stripe price ID directly from the product definition
    const stripePriceId = size === '100ml' ? productDefinition.stripeId100ml : productDefinition.stripeId50ml;
    if (!stripePriceId) {
      return NextResponse.json({ error: 'Stripe price ID not configured for this size.' }, { status: 400 });
    }

    // Get price (with override if any)
    const override = await getProductOverride(redis, productDefinition.id);
    const basePrice = size === '100ml' ? (override?.price100ml ?? productDefinition.price100ml) : (override?.price50ml ?? productDefinition.price50ml);
    const priceCents = Math.round(basePrice * 100);

    // Apply promo discount if provided
    let finalPriceCents = priceCents;
    // (promo handling omitted for brevity – you can add it back if needed)

    // Create a Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: finalPriceCents,
      currency: 'usd',
      customer: body.customerId || undefined,
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

    // Extract customer ID safely
    let customerId: string;
    if (typeof paymentIntent.customer === 'string') {
      customerId = paymentIntent.customer;
    } else if (paymentIntent.customer && typeof paymentIntent.customer === 'object' && 'id' in paymentIntent.customer) {
      customerId = paymentIntent.customer.id;
    } else {
      customerId = 'n/a';
    }

    // Archive the sale
    const archiveRecord: ArchiveRecord = {
      email,
      variant: productDefinition.name,
      size,
      shippingAddress,
      id: customerId,
      registeredAt: new Date().toISOString(),
      type: 'WINNER_CHARGED',
      shippingStatus: 'PENDING_FULFILLMENT',
      amountCents: finalPriceCents,
      orderRef: `DIRECT-${Date.now().toString(36)}`,
      promoCode: promoCode || undefined,
    };
    await archiveEntry(redis, archiveRecord);

    return NextResponse.json({
      success: true,
      paymentIntentId: paymentIntent.id,
      amount: finalPriceCents / 100,
    });
  } catch (err: any) {
    console.error('[direct/route] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}