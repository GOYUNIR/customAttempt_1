import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis'; // Textbook native marketplace client integration
import { GOYUNIR_STORE_SUITE } from '../../../goyunir.config';

// AUTOMATED INITIALIZATION: Natively discovers and binds UPSTASH_REDIS_REST_URL out-of-the-box
const redis = Redis.fromEnv();

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { variant, size, email, shippingAddress, quantityChosen } = body;

    if (!email || !variant || !size || !shippingAddress) {
      return NextResponse.json({ error: "Missing required entry parameters." }, { status: 400 });
    }

    // Read limits seamlessly from your central config file tracking metrics
    const targetedProduct = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.name === variant);
    const allocationBoundary = targetedProduct ? targetedProduct.maxRaffleAllocationLimit : 10;
    const finalQuantity = Math.min(allocationBoundary, Math.max(1, parseInt(quantityChosen || 1)));

    // ANTI-FRAUD ENGINE: Enforces a strict one-entry-per-household limit matching Nike SNKRS architecture
    const addressKey = shippingAddress.trim().toLowerCase().replace(/\s+/g, '');
    const isAddressDuplicate = await redis.sismember(`drop_fraud_block:${variant}`, addressKey);

    if (isAddressDuplicate === 1) {
      return NextResponse.json({ 
        error: "DUPLICATE_ENTRY", 
        message: "Entry Flagged: This shipping address has already been securely registered for this drop pool." 
      }, { status: 409 });
    }

    const registrationPayload = { email, variant, size, address: shippingAddress, quantity: finalQuantity, registeredAt: Date.now() };
    
    // Pure atomic array queueing methods
    await redis.rpush(`drop_pool:${variant}:${size}`, JSON.stringify(registrationPayload));
    await redis.sadd(`drop_fraud_block:${variant}`, addressKey);

    return NextResponse.json({ 
      success: true, 
      message: "✓ Priority Entry Confirmed: Place verified inside the lottery draw matrix allocation." 
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
