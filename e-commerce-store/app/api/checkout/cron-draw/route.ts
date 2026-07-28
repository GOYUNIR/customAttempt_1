import { NextResponse } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { buildAbsoluteUrl, createRedisClient, createStripeClient, getFallbackEntries } from '@/lib/server-config';
import { getProductStripeId, getProductPrice, getWinnerCount } from '@/lib/storefront-config';

const redis = createRedisClient();
const stripe = createStripeClient();

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const targetSecret = `Bearer ${process.env.CRON_SECRET}`;

  if (!authHeader || authHeader !== targetSecret) {
    return NextResponse.json({ error: 'Unauthorized background clock execution.' }, { status: 401 });
  }

  try {
    console.log('🚀 Starting background automated lottery drawing...');
    const resultsSummary: Array<{ email: string; scent: string; size: string; checkout?: string }> = [];

    if (!redis) {
      return NextResponse.json({
        success: true,
        processedWinners: [],
        message: 'Redis is not configured. No draw was processed.',
      });
    }

    const fallbackEntries = getFallbackEntries();
    if (fallbackEntries.length > 0) {
      resultsSummary.push(...fallbackEntries.map((entry) => ({ email: entry.email, scent: entry.variant, size: entry.size })));
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

        for (let index = parsedPool.length - 1; index > 0; index -= 1) {
          const j = Math.floor(Math.random() * (index + 1));
          [parsedPool[index], parsedPool[j]] = [parsedPool[j], parsedPool[index]];
        }

        const duplicateBlockKey = `drop_fraud_block:${product.name}:${size}`;
        const targetLimit = getWinnerCount(GOYUNIR_STORE_SUITE, size);
        const winnersCount = Math.min(targetLimit, parsedPool.length);
        let successCount = 0;

        for (const entry of parsedPool) {
          if (successCount >= winnersCount) break;

          const email = String(entry.email ?? '');
          const customerId = String(entry.customerId ?? '');
          const paymentMethodId = String(entry.paymentMethodId ?? '');
          const priceCents = Math.round(getProductPrice(product, size) * 100);

          if (stripe && customerId && paymentMethodId) {
            try {
              const paymentIntent = await stripe.paymentIntents.create({
                amount: priceCents,
                currency: 'usd',
                customer: customerId,
                payment_method: paymentMethodId,
                off_session: true,
                confirm: true,
                metadata: {
                  product: product.name,
                  size,
                  email,
                },
                statement_descriptor: `${product.name.slice(0, 22)} ${size}`,
              });

              console.log(`✅ Auto-charge succeeded for ${email}: ${paymentIntent.id}`);
              resultsSummary.push({ email, scent: product.name, size, checkout: `charged:${paymentIntent.id}` });
              successCount += 1;
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : 'Unknown Stripe charge error';
              console.warn(`⚠️ Auto-charge failed for ${email}: ${message}`);
              continue;
            }
          } else if (stripe) {
            const fallbackSession = await stripe.checkout.sessions.create({
              payment_method_types: ['card'],
              customer_email: email,
              line_items: [{ price: getProductStripeId(product, size), quantity: 1 }],
              mode: 'payment',
              allow_promotion_codes: true,
              expires_at: Math.floor(Date.now() / 1000) + 1800,
              success_url: `${buildAbsoluteUrl(request, '/')}?session=success`,
              cancel_url: `${buildAbsoluteUrl(request, '/')}?session=cancel`,
            });

            resultsSummary.push({ email, scent: product.name, size, checkout: fallbackSession.url ?? undefined });
            successCount += 1;
          }
        }

        await redis.del(poolKey);
        await redis.del(duplicateBlockKey);
      }
    }

    return NextResponse.json({ success: true, processedWinners: resultsSummary });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown draw error';
    console.error('❌ Background Cron Logic Failure:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
