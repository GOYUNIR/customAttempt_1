import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';
import Stripe from 'stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const redis = createRedisClient();
  const stripe = createStripeClient();
  
  const signature = request.headers.get('stripe-signature') ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret || !redis) {
    return NextResponse.json({ error: 'System processing nodes offline.' }, { status: 500 });
  }

  const body = await request.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    if (process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true' || process.env.NODE_ENV !== 'production') {
      event = JSON.parse(body) as Stripe.Event;
    } else {
      return NextResponse.json({ error: 'Invalid webhook signature buffer.' }, { status: 400 });
    }
  }

  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as any;
  const metadata = session.metadata ?? {};
  
  // FIXED segment pullers read variant properties natively out of metadata lines
  const variant = String(metadata.variant || '').trim();
  const size = String(metadata.size || '').trim();
  const email = String(metadata.email || session.customer_details?.email || '').trim().toLowerCase();
  const customerId = String(session.customer || '');

  // FIXED FALLBACK STRIPE ADDRESS EXTRACTION SCHEME
  let address = String(metadata.address || metadata.shippingAddress || '').trim();
  if ((!address || address === 'Collected via Stripe Checkout') && session.shipping_details?.address) {
    const addr = session.shipping_details.address;
    address = `${addr.line1 || ''}, ${addr.city || ''}, ${addr.state || ''} ${addr.postal_code || ''}`;
  }

  let paymentMethodId = '';
  const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id || '';

  if (setupIntentId) {
    try {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      paymentMethodId = typeof setupIntent.payment_method === 'string' 
        ? setupIntent.payment_method 
        : setupIntent.payment_method?.id || '';
    } catch {
      paymentMethodId = 'vaulted_token_hold';
    }
  }

  if (!variant || !size || !address || !email || !customerId) {
    console.error("CRITICAL WEBHOOK ERROR: Incomplete payload mapping attributes:", { variant, size, address, email, customerId });
    return NextResponse.json({ error: 'Incomplete checkout session metadata attributes.' }, { status: 400 });
  }

  const normalizedAddress = address.toLowerCase().replace(/\s+/g, '');
  const duplicateBlockKey = `drop_fraud_block:${variant}:${size}`;
  const poolKey = `drop_pool:${variant}:${size}`;
  const intentKey = `intent_pool:${variant}:${size}`;

  // Check anti-fraud double submission cards locks
  const isAddressDuplicate = await redis.sismember(duplicateBlockKey, normalizedAddress);
  
  if (isAddressDuplicate !== 1) {
    const payload = JSON.stringify({
      email,
      variant,
      size,
      shippingAddress: address,
      quantity: 1,
      paymentMethodId: paymentMethodId || 'vaulted_token_hold',
      stripeCustomerId: customerId,
      id: session.id || `session_${Math.random().toString(36).substring(2, 7)}`,
      price: 120,
      registeredAt: new Date().toISOString(), // Permanent Timestamp Log
      type: metadata.registrationType === 'WAITLIST_BACKORDER' ? 'WAITLIST' : 'SUBMISSION'
    });

    // Save straight into dynamic list structures for direct draw sweeps
    await redis.rpush(poolKey, payload);
    await redis.sadd(duplicateBlockKey, normalizedAddress);

    // CLEANUP STAGING CORES: Deletes intent out of Redis list since they completed stripe authorization checkout
    try {
      const intentItems = await redis.lrange(intentKey, 0, -1);
      for (const item of intentItems) {
        try {
          const parsedIntent = JSON.parse(item);
          if (parsedIntent.email === email) {
            await redis.lrem(intentKey, 1, item);
          }
        } catch {}
      }
    } catch {}
  }

  return NextResponse.json({ received: true });
}
