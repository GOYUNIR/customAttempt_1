import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, getCatalogArchiveRecords } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getNextDrawTimestampForSchedule, resolveProductSchedule, getProductPrice, getWinnerCount, getAvailableSizes } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
  if (!master || password !== master) return NextResponse.json({ error: 'Invalid password' }, { status: 403 });

  const results: TestResult[] = [];
  const push = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // 1. Environment variables present
  const requiredEnv = [
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN', 'ADMIN_BASIC_AUTH_USERNAME', 'ADMIN_BASIC_AUTH_PASSWORD', 'CRON_SECRET',
  ];
  for (const key of requiredEnv) {
    push(`Env: ${key}`, Boolean(process.env[key]), process.env[key] ? 'set' : 'MISSING — required for this feature to work');
  }
  push('Env: RESEND_API_KEY', Boolean(process.env.RESEND_API_KEY), process.env.RESEND_API_KEY ? 'set' : 'missing — winner/promoter emails will silently skip');
  push('Env: RESEND_FROM', Boolean(process.env.RESEND_FROM), process.env.RESEND_FROM ? 'set' : 'not set — emails send from Resend sandbox address, real delivery is unreliable');

  // 2. Redis connectivity
  const redis = createRedisClient();
  if (redis) {
    try {
      const testKey = 'selftest:ping';
      await redis.set(testKey, String(Date.now()));
      const readBack = await redis.get(testKey);
      push('Redis connectivity', Boolean(readBack), readBack ? 'read/write ok' : 'wrote but could not read back');
    } catch (err: any) {
      push('Redis connectivity', false, `Error: ${err.message}`);
    }
  } else {
    push('Redis connectivity', false, 'createRedisClient() returned null — check env vars');
  }

  // 3. Stripe connectivity
  const stripe = createStripeClient();
  if (stripe) {
    try {
      await stripe.prices.list({ limit: 1 });
      push('Stripe connectivity', true, 'API reachable');
    } catch (err: any) {
      push('Stripe connectivity', false, `Error: ${err.message}`);
    }
  } else {
    push('Stripe connectivity', false, 'createStripeClient() returned null — check STRIPE_SECRET_KEY');
  }

  // 4. Per-product checks
  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
    const schedule = resolveProductSchedule(GOYUNIR_STORE_SUITE, product);
    try {
      const ts = getNextDrawTimestampForSchedule(schedule);
      const valid = Number.isFinite(ts) && ts > Date.now() - 24 * 60 * 60 * 1000;
      push(`${product.name}: schedule computes`, valid, valid ? `next draw ${new Date(ts).toLocaleString()}` : `invalid timestamp: ${ts}`);
    } catch (err: any) {
      push(`${product.name}: schedule computes`, false, `Error: ${err.message}`);
    }

    for (const size of getAvailableSizes(GOYUNIR_STORE_SUITE)) {
      const price = getProductPrice(product, size);
      push(`${product.name} ${size}: price valid`, price > 0, price > 0 ? `$${price}` : `price is ${price} — should be > 0`);

      const stripeId = size === '100ml' ? product.stripeId100ml : product.stripeId50ml;
      const looksReal = stripeId.startsWith('price_') && !stripeId.includes('placeholder');
      push(`${product.name} ${size}: Stripe Price ID set`, looksReal, looksReal ? stripeId : `${stripeId} — looks like a placeholder`);

      if (stripe && looksReal) {
        try {
          const stripePrice = await stripe.prices.retrieve(stripeId);
          const expectedCents = Math.round(price * 100);
          const matches = stripePrice.unit_amount === expectedCents;
          push(
            `${product.name} ${size}: Stripe price matches config`,
            matches,
            matches
              ? `Stripe: $${(stripePrice.unit_amount || 0) / 100} matches config`
              : `Stripe has $${(stripePrice.unit_amount || 0) / 100}, config says $${price} — only matters if this product ever falls back to a Stripe Checkout session`,
          );
        } catch (err: any) {
          push(`${product.name} ${size}: Stripe price exists`, false, `Error retrieving price: ${err.message}`);
        }
      }

      const winners = getWinnerCount(GOYUNIR_STORE_SUITE, size);
      push(`${product.name} ${size}: winner count valid`, winners > 0, winners > 0 ? `${winners} per draw` : `${winners} — should be > 0`);
    }
  }

  // 5. Catalog archive readable
  if (redis) {
    try {
      const records = await getCatalogArchiveRecords(redis);
      push('Catalog archive readable', true, `${records.length} archived product(s)`);
    } catch (err: any) {
      push('Catalog archive readable', false, `Error: ${err.message}`);
    }
  }

  // 6. Slugs unique
  const slugs = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.slug);
  const uniqueSlugs = new Set(slugs);
  push('Product slugs unique', uniqueSlugs.size === slugs.length, uniqueSlugs.size === slugs.length ? 'no duplicates' : 'DUPLICATE SLUGS — sharing links will resolve to the wrong product');

  const passCount = results.filter((r) => r.pass).length;
  return NextResponse.json({
    summary: `${passCount}/${results.length} checks passed`,
    allPassed: passCount === results.length,
    results,
    ranAt: new Date().toISOString(),
  });
}