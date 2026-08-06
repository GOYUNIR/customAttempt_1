import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, getProductOverride } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'System offline.' }, { status: 500 });
    }

    const body = await request.json();
    const { productId, size, quantity } = body;
    if (!productId || !size) {
      return NextResponse.json({ error: 'Missing product or size.' }, { status: 400 });
    }

    const product = GOYUNIR_STORE_SUITE.productCatalog.find(p => p.id === productId);
    if (!product) {
      return NextResponse.json({ error: 'Product not found.' }, { status: 404 });
    }

    const override = await getProductOverride(redis, product.id);
    const price = size === '100ml'
      ? (override?.price100ml ?? product.price100ml)
      : (override?.price50ml ?? product.price50ml);

    if (!price || price <= 0) {
      return NextResponse.json({ error: 'Price not set for this product/size.' }, { status: 400 });
    }

    // Build product image URL – use first image from the product's images array if available, else fallback
    const imageUrl = (product as any).images && Array.isArray((product as any).images) && (product as any).images.length > 0
      ? (product as any).images[0]
      : `/images/${product.prefix}/1.jpeg`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${product.name} (${size})`,
            description: product.desc || '',
            images: [imageUrl],
          },
          unit_amount: Math.round(price * 100),
        },
        quantity: quantity || 1,
      }],
      mode: 'payment',
      success_url: `${request.headers.get('origin') || 'https://yourdomain.com'}/?checkout=success`,
      cancel_url: `${request.headers.get('origin') || 'https://yourdomain.com'}/?checkout=cancel`,
      metadata: {
        productId,
        size,
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}