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
    const poolKey = `drop_pool:${variant}:${size}`;

    // ✅ FIXED AUTOMATED FUTURE DROPS ENFORCEMENT: Saves complete registration blocks into pools
    if (isWaitlistMode) {
      const waitlistRafflePayload = JSON.stringify({
        email: clientEmail,
        variant,
        size,
        shippingAddress: shippingAddress || 'No Address Provided',
        quantity: Number(quantityChosen) || 1,
        paymentMethodId: 'PRE_AUTHORIZED_WAITLIST', // Placeholder bypass token layout
        stripeCustomerId: 'WAITLIST_AUTOMATED_UPCOMING',
        id: `wait_${Math.random().toString(36).substring(2, 9)}`,
        price: 120,
        registeredAt: timestamp,
        type: 'WAITLIST' // Tagged clearly so you see them inside your searchable ledger widgets
      });

      // Secure data row directly into dynamic list structures for next launch sweep matrix
      await redis.rpush(poolKey, waitlistRafflePayload);

      return NextResponse.json({ 
        success: true, 
        message: '✓ AUTOMATED ENTRY SECURED: Saved to restock pools. You will be automatically entered into the next drawing session.' 
      });
    }

    // STANDARD ACTIVE TIMER RAFFLE CHANNELS
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
        shippingAddress: shippingAddress || 'Collected via Stripe Checkout'
      }
    });

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
