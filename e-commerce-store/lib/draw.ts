import { NextRequest } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { buildAbsoluteUrl, createRedisClient, createStripeClient } from '@/lib/server-config';
import { getProductPrice, getProductStripeId, getWinnerCount } from '@/lib/storefront-config';

export interface DrawResult {
  email: string;
  scent: string;
  size: string;
  checkout?: string;
  status: 'charged' | 'checkout' | 'skipped';
  message?: string;
}

export async function runDropDraw(request: Request | NextRequest) {
  const redis = createRedisClient();
  const stripe = createStripeClient();
  const resultsSummary: DrawResult[] = [];

  if (!redis) {
    return {
      success: true,
      processedWinners: [],
      message: 'Redis is not configured. No draw was processed.',
    };
  }

  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
    for (const size of ['50ml', '100ml']) {
      const poolKey = `drop_pool:${product.name}:${size}`;
      const totalEntries = await redis.llen(poolKey);

      if (totalEntries === 0) continue;

      const allRegistrations = await redis.lrange(poolKey, 0, -1);
      const parsedPool = allRegistrations.map((entry: unknown) => {
        if (typeof entry === 'string') {
          return JSON.parse(entry) as Record<string, unknown>;
        }
        return entry as Record<string, unknown>;
      });

      // Secure Fisher-Yates element shuffling pattern
      for (let index = parsedPool.length - 1; index > 0; index -= 1) {
        const j = Math.floor(Math.random() * (index + 1));
        [parsedPool[index], parsedPool[j]] = [parsedPool[j], parsedPool[index]];
      }

      const duplicateBlockKey = `drop_fraud_block:${product.name}:${size}`;
      const targetLimit = getWinnerCount(GOYUNIR_STORE_SUITE, size);
      let successCount = 0;

      for (const entry of parsedPool) {
        if (successCount >= targetLimit) break;

        const email = String(entry.email ?? '');
        const customerId = String(entry.customerId ?? '');
        const paymentMethodId = String(entry.paymentMethodId ?? '');
        const priceCents = Math.round(getProductPrice(product, size) * 100);

        let directChargeCompleted = false;

        if (stripe && customerId && paymentMethodId) {
          try {
            // FIXED: Using statement_descriptor_suffix safely instead of statement_descriptor
            const paymentIntent = await stripe.paymentIntents.create({
              amount: priceCents,
              currency: 'usd',
              customer: customerId,
              payment_method: paymentMethodId,
              off_session: true,
              confirm: true,
              metadata: { product: product.name, size, email },
              statement_descriptor_suffix: size.slice(0, 10), 
            });

            resultsSummary.push({
              email,
              scent: product.name,
              size,
              checkout: `charged:${paymentIntent.id}`,
              status: 'charged',
              message: 'Auto-charge succeeded.',
            });
            successCount += 1;
            directChargeCompleted = true;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Charge failed.';
            resultsSummary.push({
              email,
              scent: product.name,
              size,
              status: 'skipped',
              message: `Auto-charge failed: ${message}`,
            });
            
            // Backup Failover link generation block
            if (stripe) {
              const fallbackSession = await stripe.checkout.sessions.create({
                customer: customerId,
                payment_method_types: ['card'],
                line_items: [{ price: getProductStripeId(product, size), quantity: 1 }],
                mode: 'payment',
                expires_at: Math.floor(Date.now() / 1000) + 1800,
                success_url: `${buildAbsoluteUrl(request as Request, '/')}?session=success`,
                cancel_url: `${buildAbsoluteUrl(request as Request, '/')}?session=cancel`,
              });

              resultsSummary.push({
                email,
                scent: product.name,
                size,
                checkout: fallbackSession.url ?? undefined,
                status: 'checkout',
                message: 'Card declined/error - Failover checkout session created.',
              });
              successCount += 1;
            }
            directChargeCompleted = true;
          }
        }

        if (!directChargeCompleted && stripe) {
          const fallbackSession = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: getProductStripeId(product, size), quantity: 1 }],
            mode: 'payment',
            expires_at: Math.floor(Date.now() / 1000) + 1800,
            success_url: `${buildAbsoluteUrl(request as Request, '/')}?session=success`,
            cancel_url: `${buildAbsoluteUrl(request as Request, '/')}?session=cancel`,
          });

          resultsSummary.push({
            email,
            scent: product.name,
            size,
            checkout: fallbackSession.url ?? undefined,
            status: 'checkout',
            message: 'Fallback checkout session created.',
          });
          successCount += 1;
        }
      }

      await redis.del(poolKey);
      await redis.del(duplicateBlockKey);
    }
  }

  try {
    // @ts-ignore
    if (typeof globalThis !== 'undefined') globalThis.__goyunirLastDraw = resultsSummary;
  } catch {}

  return {
    success: true,
    processedWinners: resultsSummary,
  };
}

try {
  // @ts-ignore
  if (typeof globalThis !== 'undefined') {
    // @ts-ignore
    globalThis.__goyunirLastDraw = globalThis.__goyunirLastDraw ?? null;
  }
} catch {}
