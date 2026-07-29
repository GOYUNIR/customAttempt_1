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

    // 1. FORCE REAL STRIPE CUSTOMER REGISTRATION MINTING
    let stripeCustomer;
    const existingCustomers = await stripe.customers.list({ email: clientEmail, limit: 1 });
    if (existingCustomers.data.length > 0) {
      stripeCustomer = existingCustomers.data[0];
    } else {
      stripeCustomer = await stripe.customers.create({
        email: clientEmail,
        description: `GOYUNIR Registrant: ${clientEmail}`,
        metadata: { initialShippingAddress: shippingAddress || 'Form Input' }
      });
    }

    const hostHeader = request.headers.get('host') || 'localhost:3000';
    const protocol = hostHeader.includes('localhost') ? 'http' : 'https';
    const domainUrl = `${protocol}://${hostHeader}`;

    // 2. LAUNCH SECURE VAULT CONTAINER TIED TO THAT CUSTOMER
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'setup', 
      customer: stripeCustomer.id, // Fixed: Links profile to customer registry immediately
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
        registrationType: isWaitlistMode ? 'WAITLIST_BACKORDER' : 'STANDARD_RAFFLE'
      }
    });

    // Log the active intent tracking counts immediately
    const intentPayload = JSON.stringify({
      email: clientEmail,
      variant,
      size,
      shippingAddress: shippingAddress || 'Form Input Field Entry',
      registeredAt: timestamp
    });
    await redis.rpush(`intent_pool:${variant}:${size}`, intentPayload);

    return NextResponse.json({ success: true, sessionUrl: session.url });

  } catch (err: any) {
    console.error("CRITICAL CHECKOUT ENDPOINT CRASH:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
