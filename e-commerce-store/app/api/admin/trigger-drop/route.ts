import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, safeParseRedisItem } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getProductPrice } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();
    if (!redis || !stripe) {
      return NextResponse.json({ error: 'System processing nodes offline.' }, { status: 500 });
    }

    let targetPoolSignature = 'ALL_POOLS';
    let inputPassword = '';
    try {
      const body = await request.json();
      targetPoolSignature = body.targetPool || 'ALL_POOLS';
      inputPassword = body.verificationKey || '';
    } catch {}

    const masterPassword = process.env.ADMIN_BASIC_AUTH_PASSWORD;
    if (!masterPassword) {
      return NextResponse.json(
        { error: 'Server misconfigured: ADMIN_BASIC_AUTH_PASSWORD is not set.' },
        { status: 500 },
      );
    }
    if (inputPassword !== masterPassword) {
      return NextResponse.json({ error: '⚠️ ACCESS REJECTED: Invalid master operation password.' }, { status: 403 });
    }

    const processedWinners: any[] = [];
    let grandRevenueChargesCount = 0;
    let allPoolKeys = await redis.keys('*drop_pool*');
    if (targetPoolSignature !== 'ALL_POOLS') {
      allPoolKeys = allPoolKeys.filter((k: string) => k === targetPoolSignature);
    }
    if (!allPoolKeys || allPoolKeys.length === 0) {
      return NextResponse.json({ success: true, drawSummary: { totalSuccessfulCharges: 0, processedWinners: [] } });
    }

    for (const poolKey of allPoolKeys) {
      try {
        const listLength = await redis.llen(poolKey);
        const keyParts = poolKey.split(':');
        const productName = String(keyParts[1] || 'Elysian White');
        const productSize = String(keyParts[2] || '50ml');
        const productDefinition = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.name === productName);
        const priceCents = productDefinition ? Math.round(getProductPrice(productDefinition, productSize) * 100) : 8500;

        if (listLength === 0) continue;
        const entries = await redis.lrange(poolKey, 0, -1);

        const shuffled = [...entries];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const inventoryLimit = productSize === '50ml' ? 10 : 5;
        let successfulPoolCaptures = 0;

        for (const winnerStr of shuffled) {
          if (successfulPoolCaptures >= inventoryLimit) break;

          const rawWinnerData = safeParseRedisItem<any>(winnerStr);
          if (!rawWinnerData) continue;
          const winnerData = rawWinnerData.email && typeof rawWinnerData.email === 'object' ? rawWinnerData.email : rawWinnerData;

          const winnerEmail = String(winnerData.email || 'goyunir@gmail.com');
          const paymentMethod = winnerData.paymentMethodId || null;
          const customerId = winnerData.stripeCustomerId || null;
          const shippingAddress = winnerData.shippingAddress || winnerData.address || 'No Address Logged';

          try {
            if (paymentMethod && customerId) {
              const chargeIntent = await stripe.paymentIntents.create({
                amount: priceCents,
                currency: 'usd',
                customer: customerId,
                payment_method: paymentMethod,
                off_session: true,
                confirm: true,
                receipt_email: winnerEmail,
                description: `GOYUNIR Lottery Win Allocation: ${productName} (${productSize})`,
              });
              grandRevenueChargesCount++;
              successfulPoolCaptures++;

              const archivedRecord = {
                email: winnerEmail,
                variant: productName,
                size: productSize,
                shippingAddress,
                id: customerId,
                registeredAt: new Date().toISOString(),
                type: 'PROCESSED_WINNER_PAID',
              };
              await redis.rpush('drop_history:archived_logs', JSON.stringify(archivedRecord));
              processedWinners.push({ email: winnerEmail, product: productName, size: productSize, status: 'SUCCESS_CHARGED' });
            }
          } catch (err: any) {
            processedWinners.push({ email: winnerEmail, product: productName, size: productSize, status: `DECLINED: ${err.message}` });
          }
        }

        await redis.del(poolKey);
        await redis.del(`intent_pool:${productName}:${productSize}`);
      } catch {}
    }

    const drawSummary = {
      executionTime: new Date().toLocaleString(),
      processedWinners,
      totalSuccessfulCharges: grandRevenueChargesCount,
    };
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__goyunirLastDraw = drawSummary.processedWinners;
    }

    return NextResponse.json({ success: true, drawSummary });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}