import { NextResponse } from 'next/server';
import {
  createRedisClient,
  createStripeClient,
  emailBlockKey,
  poolStatField,
  POOL_STATS_KEY,
  archiveEntry,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure offline.' }, { status: 500 });
    }

    const body = await request.json();
    const { variant, size, email, shippingAddress, quantityChosen, promoCode, ref } = body;

    if (!email || !variant || !size || !shippingAddress) {
      return NextResponse.json({ error: 'Missing registration details.' }, { status: 400 });
    }

    const clientEmail = String(email).trim().toLowerCase();
    const timestamp = new Date().toISOString();

    const isEmailAlreadyEntered = await redis.sismember(emailBlockKey(variant, size), clientEmail);
    if (isEmailAlreadyEntered === 1) {
      const otherNames = getVisibleProducts(GOYUNIR_STORE_SUITE)
        .filter((p) => p.name !== variant)
        .map((p) => p.name);
      const upsell =
        otherNames.length > 0
          ? ` You’re already entered for ${variant}. Same email works on ${otherNames.join(' or ')} — one entry per scent.`
          : ` You’re already entered for ${variant}. One entry per email — you’re all set.`;

      return NextResponse.json({
        success: false,
        alreadyEntered: true,
        error: upsell.trim(),
        upsellProducts: otherNames,
      });
    }

    let stripeCustomer;
    const existingCustomers = await stripe.customers.list({ email: clientEmail, limit: 1 });
    if (existingCustomers.data.length > 0) {
      stripeCustomer = existingCustomers.data[0];
    } else {
      stripeCustomer = await stripe.customers.create({
        email: clientEmail,
        description: `GOYUNIR Registrant: ${clientEmail}`,
        metadata: { initialShippingAddress: shippingAddress },
      });
    }

    const hostHeader = request.headers.get('host') || 'localhost:3000';
    const protocol = hostHeader.includes('localhost') ? 'http' : 'https';
    const domainUrl = `${protocol}://${hostHeader}`;

    const code = String(promoCode || ref || '')
      .trim()
      .toUpperCase();

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'setup',
      customer: stripeCustomer.id,
      success_url: `${domainUrl}/?setup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainUrl}/?setup=cancel`,
      metadata: {
        variant: String(variant),
        size: String(size),
        quantity: String(quantityChosen || 1),
        email: clientEmail,
        address: shippingAddress,
        promoCode: code || '',
      },
    });

    const intentPayload = JSON.stringify({
      email: clientEmail,
      variant,
      size,
      shippingAddress,
      registeredAt: timestamp,
      promoCode: code || undefined,
      recoveryEarlySent: false,
      recoveryPreDrawSent: false,
    });
    await redis.rpush(`intent_pool:${variant}:${size}`, intentPayload);
    await redis.hincrby(POOL_STATS_KEY, poolStatField('int', variant, size), 1);

    await archiveEntry(redis, {
      email: clientEmail,
      variant,
      size,
      shippingAddress,
      id: stripeCustomer.id,
      registeredAt: timestamp,
      type: 'INTENT_STARTED',
    });

    return NextResponse.json({ success: true, sessionUrl: session.url });
  } catch (err: any) {
    console.error('CHECKOUT ERROR:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}