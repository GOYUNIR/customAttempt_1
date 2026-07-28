import { NextResponse } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { createRedisClient, createStripeClient, buildAbsoluteUrl } from '@/lib/server-config';
import { getProductPrice, getWinnerCount, getProductStripeId } from '@/lib/storefront-config';

const redis = createRedisClient();
const stripe = createStripeClient();
const CONCURRENCY_LIMIT = 25; // Safe throttle for high traffic volume

export async function POST(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized execution.' }, { status: 401 });
  }

  if (!redis || !stripe) {
    return NextResponse.json({ error: 'Infrastructure offline.' }, { status: 500 });
  }

  const operationsLog: Array<any> = [];

  try {
    for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
      for (const size of ['50ml', '100ml']) {
        const poolKey = `drop_pool:${product.name}:${size}`;
        const totalWinnersNeeded = getWinnerCount(GOYUNIR_STORE_SUITE, size);
        
        if (totalWinnersNeeded <= 0) continue;
        const winnersList: Array<{ email: string; customerId: string; paymentMethodId: string }> = [];

        // Atomically pop winners from Redis pool queue
        while (winnersList.length < totalWinnersNeeded) {
          const rawEntry: any = await redis.lpop(poolKey); // Cast as any to resolve type mismatch
          if (!rawEntry) break; 
          
          // Ensure it parses safely whether Redis returns a string or an already parsed object
          const parsedEntry = typeof rawEntry === 'string' ? JSON.parse(rawEntry) : rawEntry;
          winnersList.push(parsedEntry);
        }

        // Wipe the remaining raffle keys clean for this item
        await redis.del(poolKey);
        await redis.del(`drop_fraud_block:${product.name}:${size}`);

        const priceCents = Math.round(getProductPrice(product, size) * 100);

        // Process Stripe charges in throttled batches
        for (let i = 0; i < winnersList.length; i += CONCURRENCY_LIMIT) {
          const batch = winnersList.slice(i, i + CONCURRENCY_LIMIT);
          
          await Promise.all(
            batch.map(async (winner) => {
              try {
                const paymentIntent = await stripe.paymentIntents.create({
                  amount: priceCents,
                  currency: 'usd',
                  customer: winner.customerId,
                  payment_method: winner.paymentMethodId,
                  off_session: true, // Charge runs while user is offline
                  confirm: true,
                });

                operationsLog.push({ email: winner.email, status: 'CHARGED', id: paymentIntent.id });
              } catch (error: any) {
                // If the automatic charge is declined, instantly create a backup payment link 
                try {
                  const recoverySession = await stripe.checkout.sessions.create({
                    customer: winner.customerId,
                    payment_method_types: ['card'],
                    line_items: [{ price: getProductStripeId(product, size), quantity: 1 }],
                    mode: 'payment',
                    expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 minutes to pay
                    success_url: `${buildAbsoluteUrl(request, '/')}?session=success`,
                    cancel_url: `${buildAbsoluteUrl(request, '/')}?session=cancel`,
                  });
                  operationsLog.push({ email: winner.email, status: 'DECLINED_BACKUP_LINK_SENT', url: recoverySession.url });
                } catch {
                  operationsLog.push({ email: winner.email, status: 'FAILED_ENTIRELY' });
                }
              }
            })
          );
        }
      }
    }

    return NextResponse.json({ success: true, log: operationsLog });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
