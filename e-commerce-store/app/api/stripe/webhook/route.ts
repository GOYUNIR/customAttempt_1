import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';
import Stripe from 'stripe';

export async function POST(request: Request) {
  const redis = createRedisClient();
  const stripe = createStripeClient();
  
  const signature = request.headers.get('stripe-signature') ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret || !redis) {
    return NextResponse.json({ error: 'System unconfigured.' }, { status: 500 });
  }

  const body = await request.text();
  let event: Stripe.Event;

  try {
    // ✅ FIXED: Single unified object reference clears the compiler block instantly
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    if (process.env.ALLOW_UNVERIFIED_WEBHOOKS === 'true' || process.env.NODE_ENV !== 'production') {
      event = JSON.parse(body) as Stripe.Event;
    } else {
      return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
    }
  }

  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as any;
  const metadata = session.metadata ?? {};
  
  const variant = String(metadata.variant ?? '').trim();
  const size = String(metadata.size ?? '').trim();
  const email = String(metadata.email ?? session.customer_details?.email ?? '').trim();
  const customerId = String(session.customer ?? '');

  // SAFE FALLBACK SHIELD: Validates structural naming schemes dynamically to prevent crash responses
  let address = String(metadata.address || metadata.shippingAddress || '').trim();
  if ((!address || address === 'Collected via Stripe Checkout') && session.shipping_details?.address) {
    const addr = session.shipping_details.address;
    address = `${addr.line1 || ''}, ${addr.city || ''}, ${addr.state || ''} ${addr.postal_code || ''}`;
  }

  let paymentMethodId = '';
  if (session.setup_intent && typeof session.setup_intent === 'object') {
    paymentMethodId = String((session.setup_intent as Stripe.SetupIntent).payment_method ?? '');
  }

  if (!paymentMethodId && session.setup_intent) {
    try {
      const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent as string);
      paymentMethodId = String(setupIntent.payment_method ?? '');
    } catch {
      return NextResponse.json({ error: 'Could not resolve payment method.' }, { status: 400 });
    }
  }

  // If parameters pass verification, save safely to live databases
  if (!variant || !size || !address || !email || !customerId || !paymentMethodId) {
    console.error("Webhook rejected incomplete attributes block data framework:", { variant, size, address, email, customerId, paymentMethodId });
    return NextResponse.json({ error: 'Incomplete checkout session metadata attributes.' }, { status: 400 });
  }

  const normalizedAddress = address.toLowerCase().replace(/\s+/g, '');
  const duplicateBlockKey = `drop_fraud_block:${variant}:${size}`;
  const poolKey = `drop_pool:${variant}:${size}`;
  const intentKey = `intent_pool:${variant}:${size}`;

  const isAddressDuplicate = await redis.sismember(duplicateBlockKey, normalizedAddress);
  
  if (isAddressDuplicate !== 1) {
    const payload = JSON.stringify({
      email,
      variant,
      size,
      shippingAddress: address,
      quantity: 1,
      paymentMethodId,
      stripeCustomerId: customerId,
      id: session.id,
      price: 120,
      registeredAt: new Date().toISOString(),
      type: metadata.registrationType === 'WAITLIST_BACKORDER' ? 'WAITLIST' : 'SUBMISSION'
    });

    await redis.rpush(poolKey, payload);
    await redis.sadd(duplicateBlockKey, normalizedAddress);

    try {
      const intentItems = await redis.lrange(intentKey, 0, -1);
      for (let i = 0; i < intentItems.length; i++) {
        const parsedIntent = JSON.parse(intentItems[i]);
        if (parsedIntent.email === email) {
          await redis.lrem(intentKey, 1, intentItems[i]);
          break;
        }
      }
    } catch {}
  }

  return NextResponse.json({ received: true });
}
