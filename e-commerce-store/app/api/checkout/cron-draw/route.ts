import { NextResponse } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { createRedisClient, createStripeClient, buildAbsoluteUrl } from '@/lib/server-config';
import { getProductPrice, getWinnerCount, getProductStripeId } from '@/lib/storefront-config';

const redis = createRedisClient();
const stripe = createStripeClient();
const CONCURRENCY_LIMIT = 25; // Safe enterprise throttle for high traffic volume

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

        // Atomically pop winners from the Redis pool queue
        while (winnersList.length < totalWinnersNeeded) {
          const rawEntry: any = await redis.lpop(poolKey); // Cast as any to resolve {} type mismatch
          if (!rawEntry) break; 
          
          // Ensure safe parsing whether Redis returns a raw string or an already parsed object
          const parsedEntry = typeof rawEntry === 'string' ? JSON.parse(rawEntry) : rawEntry;
          winnersList.push(parsedEntry);
        }

        // Wipe the remaining raffle keys clean for this item to ensure transaction isolation
        await redis.del(poolKey);
        await redis.del(`drop_fraud_block:${product.name}:${size}`);

        if (winnersList.length === 0) continue;

        const priceCents = Math.round(getProductPrice(product, size) * 100);

        // Process Stripe charges concurrently in throttled batches
        for (let i = 0; i < winnersList.length; i += CONCURRENCY_LIMIT) {
          const batch = winnersList.slice(i, i + CONCURRENCY_LIMIT);
          
          await Promise.all(
            batch.map(async (winner) => {
              try {
                // TEXTBOOK FIX: Swapped out statement_descriptor for statement_descriptor_suffix
                const paymentIntent = await stripe.paymentIntents.create({
                  amount: priceCents,
                  currency: 'usd',
                  customer: winner.customerId,
                  payment_method: winner.paymentMethodId,
                  off_session: true, // Execute while customer is offline
                  confirm: true,
                  statement_descriptor_suffix: size.slice(0, 10), // Clean statement suffix appending
                });

                operationsLog.push({ email: winner.email, status: 'CHARGED', id: paymentIntent.id });
              } catch (error: any) {
                // Failover safety logic: Creates manual email checkout link if card is declined/expired
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
