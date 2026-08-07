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
    const productSlug = String(product.slug || product.id);

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

    if (mode === 'raffle') {
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
          email: String(email),
          address: String(address),
        },
      });
      return NextResponse.json({ url: session.url, sessionId: session.id });
    } else {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customer.id,
        customer_email: email,
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
          email: String(email),
          address: String(address),
        },
        payment_intent_data: {
          receipt_email: email,
          metadata: {
            productId: String(productId),
            productSlug,
            variant: String(product.name || ''),
            size: String(size),
            email: String(email),
            address: String(address),
          },
        },
      });
      return NextResponse.json({ url: session.url, sessionId: session.id });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}