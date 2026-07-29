import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';

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

    const masterPassword = process.env.ADMIN_BASIC_AUTH_PASSWORD || 'securegoyunir2026';
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

          let winnerEmail = 'User';
          let paymentMethod = null;
          let customerId = null;
          let shippingAddress = 'No Address Logged';

          try {
            let winnerData = JSON.parse(winnerStr);
            if (winnerData && winnerData.email && typeof winnerData.email === 'object') {
              winnerData = winnerData.email;
            }
            winnerEmail = String(winnerData.email || 'goyunir@gmail.com');
            paymentMethod = winnerData.paymentMethodId || null;
            customerId = winnerData.stripeCustomerId || null;
            shippingAddress = winnerData.shippingAddress || winnerData.address || shippingAddress;
          } catch { continue; }

          try {
            if (paymentMethod && customerId) {
              // EXECUTE LIVE REVENUE CAPTURE ON STRIPE CARD ACCOUNTS
              const chargeIntent = await stripe.paymentIntents.create({
                amount: 12000,
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
                type: 'PROCESSED_WINNER_PAID'
              };
              
              await redis.rpush('drop_history:archived_logs', JSON.stringify(archivedRecord));
              processedWinners.push({ email: winnerEmail, product: productName, size: productSize, chargeId: chargeIntent.id, status: 'SUCCESS' });
            }
          } catch (err: any) {
            processedWinners.push({ email: winnerEmail, product: productName, size: productSize, status: `FAILED: ${err.message}` });
          }
        }

        await redis.del(poolKey);
        await redis.del(`intent_pool:${productName}:${productSize}`);

      } catch {}
    }

    const drawSummary = {
      executionTime: new Date().toLocaleString(),
      processedWinners,
      totalSuccessfulCharges: grandRevenueChargesCount
    };

    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__goyunirLastDraw = drawSummary.processedWinners; // Feeds the matrix panel array directly
    }

    return NextResponse.json({ success: true, drawSummary });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
