import { NextResponse } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { createRedisClient, createStripeClient, buildAbsoluteUrl, addFallbackEntry, getFallbackEntries } from '@/lib/server-config';

const redis = createRedisClient();
const stripe = createStripeClient();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { variant, size, email, shippingAddress, quantityChosen } = body as {
      variant?: string;
      size?: string;
      email?: string;
      shippingAddress?: string;
      quantityChosen?: number;
    };

    const normalizedEmail = email?.trim();
    const normalizedVariant = variant?.trim();
    const normalizedSize = size?.trim();
    const normalizedAddress = shippingAddress?.trim();

    if (!normalizedEmail || !normalizedVariant || !normalizedSize || !normalizedAddress) {
      return NextResponse.json({ error: 'Missing required entry parameters.' }, { status: 400 });
    }

    if (!stripe) {
      return NextResponse.json({ error: 'Stripe is not configured. Payment method capture is unavailable.' }, { status: 500 });
    }

    const targetedProduct = GOYUNIR_STORE_SUITE.productCatalog.find((product) => product.name === normalizedVariant);
    const allocationBoundary = targetedProduct ? targetedProduct.maxRaffleAllocationLimit : GOYUNIR_STORE_SUITE.dropSchedule.winnersPer50ml;
    const finalQuantity = Math.min(allocationBoundary, Math.max(1, Number.parseInt(String(quantityChosen || 1), 10)));

    const customer = await stripe.customers.create({
      email: normalizedEmail,
      metadata: {
        variant: normalizedVariant,
        size: normalizedSize,
        address: normalizedAddress,
        quantity: String(finalQuantity),
      },
    });

    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'setup',
      billing_address_collection: 'required',
      success_url: buildAbsoluteUrl(request, '/?setup=success'),
      cancel_url: buildAbsoluteUrl(request, '/?setup=cancel'),
      metadata: {
        variant: normalizedVariant,
        size: normalizedSize,
        address: normalizedAddress,
        quantity: String(finalQuantity),
        email: normalizedEmail,
      },
      setup_intent_data: {
        metadata: {
          variant: normalizedVariant,
          size: normalizedSize,
          address: normalizedAddress,
          quantity: String(finalQuantity),
          email: normalizedEmail,
        },
      },
    });

    const responsePayload = {
      success: true,
      sessionUrl: checkoutSession.url,
      customerId: customer.id,
      message: 'Complete your card setup to lock in the entry and enable automatic charge if you win.',
    };

    // prevent duplicate registration by address or email in fallback store or Redis
    const normalizedAddressKey = normalizedAddress.toLowerCase().replace(/\s+/g, '');
    if (redis) {
      try {
        const isDuplicate = await redis.sismember(`drop_fraud_block:${normalizedVariant}`, normalizedAddressKey);
        if (isDuplicate === 1) {
          // previously returned 409; instead return a warning so users aren't blocked
          return NextResponse.json({ ...responsePayload, warning: 'This address or variant is already registered.' });
        }
      } catch {}
    } else {
      const fallback = getFallbackEntries();
      const exists = fallback.some((e) => (String(e.variant) === normalizedVariant && String(e.address).toLowerCase().replace(/\s+/g, '') === normalizedAddressKey) || String(e.email) === normalizedEmail);
      if (exists) {
        return NextResponse.json({ ...responsePayload, warning: 'This address or email is already registered (pending).' });
      }
    }

    // push a fallback entry so admin UI can surface pending entries before the webhook arrives
    try {
      addFallbackEntry({
        email: normalizedEmail,
        variant: normalizedVariant,
        size: normalizedSize,
        address: normalizedAddress,
        quantity: finalQuantity,
        registeredAt: Date.now(),
        customerId: customer.id,
      });
    } catch {}

    if (!redis) {
      return NextResponse.json({
        ...responsePayload,
        warning: 'Redis is not configured. Your entry will only be queued after webhook confirmation when Redis becomes available.',
      });
    }

    return NextResponse.json(responsePayload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown checkout error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
