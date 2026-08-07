import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, loadProducts, getLiveProductState, ARCHIVE_LEDGER_KEY, archiveEntry } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

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

function buildRef(email: string, productId: string, size: string) {
  const seed = `${email}|${productId}|${size}|${Date.now()}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const token = Math.abs(hash >>> 0).toString(36).toUpperCase();
  return `GOY-${token.slice(0, 6)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline' }, { status: 500 });
    }

    const body = await request.json();
    const { productId, size, email, address, promoCode, ref } = body;

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
    const variant = String(product.name || product.id);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const checkoutMode = getCheckoutMode(product);
    const maxPerEmail = Math.max(1, Number(product.maxPerEmail || 1));
    const orderRef = buildRef(normalizedEmail, String(productId), String(size));

    if (checkoutMode === 'FCFS') {
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

    if (checkoutMode === 'RAFFLE') {
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
          promoCode: String(promoCode || ref || '').trim().toUpperCase(),
          ref: String(ref || promoCode || '').trim().toUpperCase(),
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
          email: normalizedEmail,
          address: String(address),
          maxPerEmail: String(maxPerEmail),
          orderRef,
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
            promoCode: String(promoCode || ref || '').trim().toUpperCase(),
            ref: String(ref || promoCode || '').trim().toUpperCase(),
          },
        },
      });
      return NextResponse.json({ url: session.url, sessionId: session.id });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}