import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, emailBlockKey, poolStatField, POOL_STATS_KEY } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'Infrastructure network interfaces offline.' }, { status: 500 });
    }

    const body = await request.json();
    const { variant, size, email, shippingAddress, quantityChosen, isWaitlistMode } = body;

    if (!email || !variant || !size) {
      return NextResponse.json({ error: 'Missing critical registration data parameters.' }, { status: 400 });
    }

    const clientEmail = String(email).trim().toLowerCase();
    const timestamp = new Date().toISOString();

    // One confirmed entry per email per drop — checked BEFORE opening a Stripe
    // session so a known-duplicate email never even reaches Stripe.
    const isEmailAlreadyEntered = await redis.sismember(emailBlockKey(variant, size), clientEmail);
    if (isEmailAlreadyEntered === 1) {
      return NextResponse.json({
        success: true,
        message: 'This email already has a confirmed entry for this drop — good luck!',
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
        metadata: { initialShippingAddress: shippingAddress || 'Form Input' },
      });
    }

    const hostHeader = request.headers.get('host') || 'localhost:3000';
    const protocol = hostHeader.includes('localhost') ? 'http' : 'https';
    const domainUrl = `${protocol}://${hostHeader}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'setup',
      customer: stripeCustomer.id,
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU'],
      },
      success_url: `${domainUrl}/?setup=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${domainUrl}/?setup=cancel`,
      metadata: {
        variant: String(variant),
        size: String(size),
        quantity: String(quantityChosen || 1),
        email: clientEmail,
        address: shippingAddress || 'Collected via Stripe Checkout',
        registrationType: isWaitlistMode ? 'WAITLIST_BACKORDER' : 'STANDARD_RAFFLE',
      },
    });

    const intentPayload = JSON.stringify({
      email: clientEmail,
      variant,
      size,
      shippingAddress: shippingAddress || 'Form Input Field Entry',
      registeredAt: timestamp,
    });
    await redis.rpush(`intent_pool:${variant}:${size}`, intentPayload);
    await redis.hincrby(POOL_STATS_KEY, poolStatField('int', variant, size), 1);

    return NextResponse.json({ success: true, sessionUrl: session.url });
  } catch (err: any) {
    console.error('CRITICAL CHECKOUT ENDPOINT CRASH:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}