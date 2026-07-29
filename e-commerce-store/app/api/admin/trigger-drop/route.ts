import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; 

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    const stripe = createStripeClient();

    if (!redis || !stripe) {
      return NextResponse.json({ error: 'System processing architecture offline.' }, { status: 500 });
    }

    // Read variant target parameters out of the incoming message body securely
    let targetPoolSignature = 'ALL_POOLS';
    try {
      const body = await request.json();
      if (body.targetPool) targetPoolSignature = body.targetPool;
    } catch {}

    const processedWinners: any[] = [];
    const scannedPoolLogs: any[] = [];
    let grandRevenueChargesCount = 0;

    let allPoolKeys = await redis.keys('*drop_pool*');
    
    // TARGETED FILTER: Isolate a specific fragrance if chosen from your admin dropdown menu
    if (targetPoolSignature !== 'ALL_POOLS') {
      allPoolKeys = allPoolKeys.filter(k => k === targetPoolSignature);
    }

    if (!allPoolKeys || allPoolKeys.length === 0) {
      return NextResponse.json({ 
        success: true, 
        drawSummary: { totalScannedPools: 0, processedWinners: [], totalSuccessfulCharges: 0 }
      });
    }

    for (const poolKey of allPoolKeys) {
      try {
        const listLength = await redis.llen(poolKey);
        const keyParts = poolKey.split(':');
        const productName = keyParts[1] || 'Fragrance Line';
        const productSize = keyParts[2] || '50ml';

        scannedPoolLogs.push({ keySignature: poolKey, entriesFound: listLength });
        if (listLength === 0) continue;

        const entries = await redis.lrange(poolKey, 0, -1);
        
        // Fisher-Yates lottery shuffle randomizer algorithm
        const shuffled = [...entries];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        const inventoryLimit = productSize === '50ml' 
          ? GOYUNIR_STORE_SUITE.dropSchedule.winnersPer50ml 
          : GOYUNIR_STORE_SUITE.dropSchedule.winnersPer100ml;

        let successfulPoolCaptures = 0;

        for (const winnerStr of shuffled) {
          if (successfulPoolCaptures >= inventoryLimit) break; 

          let winnerEmail = 'User';
          let paymentMethod = null;
          let customerId = null;
          let targetPrice = 120;

          try {
            if (winnerStr.trim().startsWith('{')) {
              let winnerData = JSON.parse(winnerStr);
              if (winnerData.email && typeof winnerData.email === 'object') winnerData = winnerData.email;
              winnerEmail = winnerData.email || winnerEmail;
              paymentMethod = winnerData.paymentMethodId || null;
              customerId = winnerData.stripeCustomerId || null;
              targetPrice = Number(winnerData.price) || 120;
            }
          } catch { continue; }

          const targetAmount = Math.round(targetPrice * 100);
          
          try {
            if (paymentMethod && customerId && !paymentMethod.startsWith('mock_')) {
              const chargeIntent = await stripe.paymentIntents.create({
                amount: targetAmount,
                currency: 'usd',
                customer: customerId,
                payment_method: paymentMethod,
                off_session: true,
                confirm: true,
                receipt_email: winnerEmail,
                description: `GOYUNIR Draw Win Allocation: ${productName} (${productSize})`,
              });

              grandRevenueChargesCount++;
              successfulPoolCaptures++;
              
              processedWinners.push({
                email: String(winnerEmail),
                product: productName,
                size: productSize,
                chargeId: chargeIntent.id,
                status: 'SUCCESSFULLY_CAPTURED'
              });
            } else {
              processedWinners.push({
                email: String(winnerEmail),
                product: productName,
                size: productSize,
                status: 'FALLBACK_LEDGER_WINNER_RECORD'
              });
            }
          } catch (chargeError: any) {
            processedWinners.push({
              email: String(winnerEmail),
              product: productName,
              size: productSize,
              status: `DROPPED_VIA_DECLINE: ${chargeError.message || 'Transaction rejected'}`
            });
          }
        }

        // Targeted Purge: Only clear out the list keys that were just processed
        await redis.del(poolKey);
        const correspondingIntentKey = `intent_pool:${productName}:${productSize}`;
        await redis.del(correspondingIntentKey);

      } catch (poolErr) {}
    }

    const drawSummary = {
      executionTime: new Date().toISOString(),
      targetScopeSelection: targetPoolSignature,
      totalScannedPools: allPoolKeys.length,
      poolBreakdown: scannedPoolLogs,
      processedWinners,
      totalSuccessfulCharges: grandRevenueChargesCount
    };

    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__goyunirLastDraw = drawSummary;
    }

    return NextResponse.json({ success: true, drawSummary });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
