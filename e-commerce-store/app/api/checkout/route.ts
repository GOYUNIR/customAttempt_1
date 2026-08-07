import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, loadProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline' }, { status: 500 });
    }

    const body = await request.json();
    const { productId, size, email, address, mode } = body;

    if (!productId || !size || !email || !address) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
    }

    const allProducts = await loadProducts(redis);
    const product = allProducts[productId];
    if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

    const priceCat = (product.priceCategories || []).find((c: any) => c.size === size);
    if (!priceCat || priceCat.price <= 0) {
      return NextResponse.json({ error: 'Price not set for this size' }, { status: 400 });
    }
    const priceCents = Math.round(priceCat.price * 100);

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

    if (mode === 'raffle') {
      // Create SetupIntent – save payment method for later charge
      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method_types: ['card'],
        metadata: { productId, size, email, address },
      });
      return NextResponse.json({ url: setupIntent.client_secret, setupIntentId: setupIntent.id });
    } else {
      // Direct checkout – charge immediately
      const paymentIntent = await stripe.paymentIntents.create({
        amount: priceCents,
        currency: 'usd',
        customer: customer.id,
        payment_method_types: ['card'],
        receipt_email: email,
        metadata: { productId, size, email, address },
      });
      return NextResponse.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}