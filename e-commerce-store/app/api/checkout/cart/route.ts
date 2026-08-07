import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  loadProducts,
  getLiveProductState,
  ARCHIVE_LEDGER_KEY,
} from '@/lib/server-config';

export const dynamic = 'force-dynamic';

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
    const cart = Array.isArray(body?.items) ? (body.items as CartInputItem[]) : [];

    if (!email || !address || cart.length === 0) {
      return NextResponse.json({ error: 'Missing checkout details.' }, { status: 400 });
    }

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

    const line_items: any[] = [];
    const summaryItems: Array<{ productId: string; variant: string; size: string; quantity: number; priceCents: number }> = [];

    for (const item of normalizedItems) {
      const product = allProducts[item.productId];
      if (!product) {
        return NextResponse.json({ error: 'A cart item no longer exists.' }, { status: 404 });
      }
      if (getCheckoutMode(product) !== 'FCFS') {
        return NextResponse.json({ error: `${product.name} is raffle-only and cannot be purchased through cart.` }, { status: 400 });
      }

      const category = (product.priceCategories || []).find((c: any) => String(c.size) === item.size);
      if (!category || Number(category.price || 0) <= 0) {
        return NextResponse.json({ error: `Price missing for ${product.name} (${item.size}).` }, { status: 400 });
      }

      const maxPerEmail = Math.max(1, Number(product.maxPerEmail || 1));
      if (item.quantity > maxPerEmail) {
        return NextResponse.json({ error: `${product.name} limit is ${maxPerEmail} per email.` }, { status: 409 });
      }

      const priorCharges = await countChargedByEmail(redis, email, String(product.name || product.id), item.size);
      if (priorCharges + item.quantity > maxPerEmail) {
        return NextResponse.json({ error: `${product.name} limit reached for this email.` }, { status: 409 });
      }

      const live = await getLiveProductState(redis, product, item.size);
      if (!live || live.inventoryRemaining < item.quantity) {
        return NextResponse.json({ error: `${product.name} (${item.size}) does not have enough inventory.` }, { status: 409 });
      }

      const priceCents = Math.round(Number(category.price || 0) * 100);
      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: priceCents,
          product_data: {
            name: `${product.name} - ${item.size}`,
            description: product.tagline || product.desc || undefined,
          },
        },
        quantity: item.quantity,
      });

      summaryItems.push({
        productId: String(product.id || item.productId),
        variant: String(product.name || product.id),
        size: item.size,
        quantity: item.quantity,
        priceCents,
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

    const origin = (() => {
      const forwardedProto = request.headers.get('x-forwarded-proto');
      const forwardedHost = request.headers.get('x-forwarded-host');
      const host = forwardedHost || request.headers.get('host') || 'localhost:3000';
      const protocol = forwardedProto || (host.includes('localhost') ? 'http' : 'https');
      return `${protocol}://${host}`;
    })();

    const returnSlug = Object.values(allProducts)[0]?.slug || 'catalog';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customer.id,
      customer_email: email,
      payment_method_types: ['card'],
      line_items,
      success_url: `${origin}/${returnSlug}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/${returnSlug}?purchase=cancel`,
      metadata: {
        checkoutType: 'cart',
        email,
        address,
        cartItems: JSON.stringify(summaryItems),
      },
    });

    return NextResponse.json({ url: session.url, sessionId: session.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
