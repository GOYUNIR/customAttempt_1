import { NextResponse } from 'next/server';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { buildAbsoluteUrl, createRedisClient, createStripeClient, getFallbackEntries } from '@/lib/server-config';
import { getProductStripeId, getWinnerCount } from '@/lib/storefront-config';

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

        const targetLimit = getWinnerCount(GOYUNIR_STORE_SUITE, size);
        const winnersCount = Math.min(targetLimit, parsedPool.length);
        const chosenWinners = parsedPool.slice(0, winnersCount);

        const targetStripeId = getProductStripeId(product, size);

        if (stripe) {
          for (const winner of chosenWinners) {
            const email = String(winner.email ?? '');
            const session = await stripe.checkout.sessions.create({
              payment_method_types: ['card'],
              customer_email: email,
              line_items: [{ price: targetStripeId, quantity: 1 }],
              mode: 'payment',
              allow_promotion_codes: true,
              expires_at: Math.floor(Date.now() / 1000) + 1800,
              success_url: `${buildAbsoluteUrl(request, '/')}?session=success`,
              cancel_url: `${buildAbsoluteUrl(request, '/')}?session=cancel`,
            });

            console.log(`✉️ WINNING TICKET DISPATCHED -> Email: ${email} | Link: ${session.url}`);
            resultsSummary.push({ email, scent: product.name, size, checkout: session.url ?? undefined });
          }
        }

        await redis.del(poolKey);
      }
    }

    return NextResponse.json({ success: true, processedWinners: resultsSummary });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown draw error';
    console.error('❌ Background Cron Logic Failure:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
