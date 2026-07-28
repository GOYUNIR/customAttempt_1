import { NextResponse } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { addFallbackEntry, createRedisClient } from '@/lib/server-config';

const redis = createRedisClient();

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

    const targetedProduct = GOYUNIR_STORE_SUITE.productCatalog.find((product) => product.name === normalizedVariant);
    const allocationBoundary = targetedProduct ? targetedProduct.maxRaffleAllocationLimit : GOYUNIR_STORE_SUITE.dropSchedule.winnersPer50ml;
    const finalQuantity = Math.min(allocationBoundary, Math.max(1, Number.parseInt(String(quantityChosen || 1), 10)));

    const addressKey = normalizedAddress.toLowerCase().replace(/\s+/g, '');

    if (redis) {
      const isAddressDuplicate = await redis.sismember(`drop_fraud_block:${normalizedVariant}`, addressKey);

      if (isAddressDuplicate === 1) {
        return NextResponse.json({
          error: 'DUPLICATE_ENTRY',
          message: 'Entry flagged: this shipping address has already been registered for this drop pool.',
        }, { status: 409 });
      }

      const registrationPayload = {
        email: normalizedEmail,
        variant: normalizedVariant,
        size: normalizedSize,
        address: normalizedAddress,
        quantity: finalQuantity,
        registeredAt: Date.now(),
      };

      await redis.rpush(`drop_pool:${normalizedVariant}:${normalizedSize}`, JSON.stringify(registrationPayload));
      await redis.sadd(`drop_fraud_block:${normalizedVariant}`, addressKey);

      return NextResponse.json({
        success: true,
        message: '✓ Priority entry confirmed: your registration is queued for the allocation draw.',
      });
    }

    const fallbackEntries = addFallbackEntry({
      email: normalizedEmail,
      variant: normalizedVariant,
      size: normalizedSize,
      address: normalizedAddress,
      quantity: finalQuantity,
      registeredAt: Date.now(),
    });

    return NextResponse.json({
      success: true,
      message: '✓ Priority entry confirmed using the safe fallback queue.',
      queuedEntries: fallbackEntries.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown checkout error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
