import { NextRequest } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import {
  buildAbsoluteUrl,
  createRedisClient,
  createStripeClient,
  safeParseRedisItem,
  archiveEntry,
  resolveCustomerId,
  resetPoolAndBlocks,
  LAST_DRAW_KEY,
} from '@/lib/server-config';
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
    return { success: true, processedWinners: [], message: 'Redis is not configured. No draw was processed.' };
  }

  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
    for (const size of ['50ml', '100ml']) {
      const poolKey = `drop_pool:${product.name}:${size}`;
      const totalEntries = await redis.llen(poolKey);
      if (totalEntries === 0) continue;

      const allRegistrations = await redis.lrange(poolKey, 0, -1);
      const parsedPool = allRegistrations
        .map((entry) => safeParseRedisItem<Record<string, unknown>>(entry))
        .filter(Boolean) as Record<string, unknown>[];

      for (let index = parsedPool.length - 1; index > 0; index -= 1) {
        const j = Math.floor(Math.random() * (index + 1));
        [parsedPool[index], parsedPool[j]] = [parsedPool[j], parsedPool[index]];
      }

      const targetLimit = getWinnerCount(GOYUNIR_STORE_SUITE, size);
      let successCount = 0;

      for (const entry of parsedPool) {
        const email = String(entry.email ?? '');
        const customerId = resolveCustomerId(entry) || '';
        const paymentMethodId = String(entry.paymentMethodId ?? '');
        const shippingAddress = String(entry.shippingAddress ?? entry.address ?? 'No Address Logged');
        const priceCents = Math.round(getProductPrice(product, size) * 100);

        if (successCount >= targetLimit) {
          await archiveEntry(redis, {
            email, variant: product.name, size, shippingAddress,
            id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'NOT_SELECTED',
          });
          continue;
        }

        let directChargeCompleted = false;
        if (stripe && customerId && paymentMethodId) {
          try {
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
            resultsSummary.push({ email, scent: product.name, size, checkout: `charged:${paymentIntent.id}`, status: 'charged', message: 'Auto-charge succeeded.' });
            successCount += 1;
            directChargeCompleted = true;
            await archiveEntry(redis, {
              email, variant: product.name, size, shippingAddress,
              id: customerId, registeredAt: new Date().toISOString(), type: 'WINNER_CHARGED',
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Charge failed.';
            resultsSummary.push({ email, scent: product.name, size, status: 'skipped', message: `Auto-charge failed: ${message}` });

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
              resultsSummary.push({ email, scent: product.name, size, checkout: fallbackSession.url ?? undefined, status: 'checkout', message: 'Card declined/error - Failover checkout session created.' });
              successCount += 1;
            }
            directChargeCompleted = true;
            await archiveEntry(redis, {
              email, variant: product.name, size, shippingAddress,
              id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_DECLINED',
            });
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
          resultsSummary.push({ email, scent: product.name, size, checkout: fallbackSession.url ?? undefined, status: 'checkout', message: 'Fallback checkout session created.' });
          successCount += 1;
          await archiveEntry(redis, {
            email, variant: product.name, size, shippingAddress,
            id: customerId || 'n/a', registeredAt: new Date().toISOString(), type: 'WINNER_CHARGED',
          });
        }
      }

      const intentKey = `intent_pool:${product.name}:${size}`;
      try {
        const remainingIntents = await redis.lrange(intentKey, 0, -1);
        for (const item of remainingIntents) {
          const parsed = safeParseRedisItem<any>(item);
          if (parsed) {
            await archiveEntry(redis, {
              email: String(parsed.email || 'Unknown'), variant: product.name, size,
              shippingAddress: String(parsed.shippingAddress || parsed.address || 'Unknown'),
              id: 'n/a', registeredAt: new Date().toISOString(), type: 'INTENT_EXPIRED',
            });
          }
        }
      } catch {}

      await resetPoolAndBlocks(redis, product.name, size);
    }
  }

  const summary = { success: true, processedWinners: resultsSummary };
  try {
    await redis.set(LAST_DRAW_KEY, JSON.stringify({
      executionTime: new Date().toLocaleString(),
      processedWinners: resultsSummary,
      totalSuccessfulCharges: resultsSummary.filter((r) => r.status === 'charged').length,
    }));
  } catch {}

  return summary;
}