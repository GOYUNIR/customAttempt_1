import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';

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

    const clientEmail = email.trim().toLowerCase();
    const timestamp = new Date().toISOString();
    const intentKey = `intent_pool:${variant}:${size}`;

    // 1. IF USER IS JOINING THE WAITLIST POST-COUNTDOWN
    if (isWaitlistMode) {
      const waitlistPayload = JSON.stringify({
        email: clientEmail,
        variant,
        size,
        shippingAddress: shippingAddress || 'No Address Provided',
        quantity: Number(quantityChosen) || 1,
        paymentMethodId: 'WAITLIST_SUBSCRIBER',
        stripeCustomerId: 'WAITLIST_PENDING',
        registeredAt: timestamp,
        type: 'WAITLIST'
      });

      // Save straight to the standard drop pool list but flag them as a safe waitlist record row
      const poolKey = `drop_pool:${variant}:${size}`;
      await redis.rpush(poolKey, waitlistPayload);

      return NextResponse.json({ 
        success: true, 
        message: '✓ RESTOCKED: You have been successfully added to our priority restock waitlist framework.' 
      });
    }

    // 2. STANDARD ACTIVE RAFFLE FLOW (WITH STRIPE REDIRECTION MINTING)
    const hostHeader = request.headers.get('host') || 'localhost:3000';
    const protocol = hostHeader.includes('localhost') ? 'http' : 'https';
    const domainUrl = `${protocol}://${hostHeader}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'setup', 
      customer_email: clientEmail,
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
        shippingAddress: shippingAddress || 'Collected via Stripe Checkout' // Forces backup persistence tracking fields
      }
    });

    // CRITICAL FIX: Save intent immediately into Redis tracking pools right when they hit the button
    const intentPayload = JSON.stringify({
      email: clientEmail,
      variant,
      size,
      shippingAddress: shippingAddress || 'Form Input Field Entry',
      registeredAt: timestamp
    });
    await redis.rpush(intentKey, intentPayload);

    return NextResponse.json({ success: true, sessionUrl: session.url });

  } catch (err: any) {
    console.error("CRITICAL CHECKOUT ENDPOINT CRASH:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
