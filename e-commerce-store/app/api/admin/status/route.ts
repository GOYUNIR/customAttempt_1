import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, getCatalogArchiveRecords } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import {
  getNextDrawTimestampForSchedule,
  resolveProductSchedule,
  getProductPrice,
  getWinnerCount,
  getAvailableSizes,
} from '@/lib/storefront-config';

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
  if (!master || password !== master) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const results: TestResult[] = [];
  const push = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  const requiredEnv = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'ADMIN_BASIC_AUTH_USERNAME',
    'ADMIN_BASIC_AUTH_PASSWORD',
    'CRON_SECRET',
  ];
  for (const key of requiredEnv) {
    push(`Env: ${key}`, Boolean(process.env[key]), process.env[key] ? 'set' : 'MISSING');
  }
  push(
    'Env: RESEND_API_KEY',
    Boolean(process.env.RESEND_API_KEY),
    process.env.RESEND_API_KEY ? 'set' : 'optional — emails off',
  );
  push(
    'Env: RESEND_FROM',
    Boolean(process.env.RESEND_FROM),
    process.env.RESEND_FROM || 'default onboarding@resend.dev',
  );

  const redis = createRedisClient();
  const stripe = createStripeClient();
  push('Redis client', Boolean(redis), redis ? 'ok' : 'failed');
  push('Stripe client', Boolean(stripe), stripe ? 'ok' : 'failed');

  if (redis) {
    try {
      await redis.ping();
      push('Redis ping', true, 'pong');
    } catch (err: any) {
      push('Redis ping', false, err.message);
    }
  }

  if (stripe) {
    try {
      await stripe.balance.retrieve();
      push('Stripe API', true, 'balance readable');
    } catch (err: any) {
      push('Stripe API', false, err.message);
    }
  }

  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
    try {
      const schedule = resolveProductSchedule(GOYUNIR_STORE_SUITE, product);
      const ts = getNextDrawTimestampForSchedule(schedule);
      const ok = Number.isFinite(ts) && ts > 0;
      push(
        `${product.name}: schedule`,
        ok,
        ok ? `next ${new Date(ts).toISOString()}` : 'invalid schedule',
      );
    } catch (err: any) {
      push(`${product.name}: schedule`, false, err.message);
    }

    for (const size of getAvailableSizes(GOYUNIR_STORE_SUITE)) {
      const price = getProductPrice(product, size);
      push(`${product.name} ${size}: price`, price > 0, price > 0 ? `$${price}` : String(price));

      const stripeId = size === '100ml' ? product.stripeId100ml : product.stripeId50ml;
      const looksReal = stripeId.startsWith('price_') && !stripeId.includes('placeholder');
      push(`${product.name} ${size}: Stripe ID`, looksReal, stripeId);

      if (stripe && looksReal) {
        try {
          const stripePrice = await stripe.prices.retrieve(stripeId);
          const expectedCents = Math.round(price * 100);
          const matches = stripePrice.unit_amount === expectedCents;
          push(
            `${product.name} ${size}: Stripe amount`,
            matches,
            matches
              ? 'matches config'
              : `Stripe $${(stripePrice.unit_amount || 0) / 100} vs config $${price}`,
          );
        } catch (err: any) {
          push(`${product.name} ${size}: Stripe retrieve`, false, err.message);
        }
      }

      const winners = getWinnerCount(GOYUNIR_STORE_SUITE, size);
      push(`${product.name} ${size}: winners`, winners > 0, String(winners));
    }
  }

  if (redis) {
    try {
      const records = await getCatalogArchiveRecords(redis);
      push('Catalog archive', true, `${records.length} archived`);
    } catch (err: any) {
      push('Catalog archive', false, err.message);
    }
  }

  const slugs = GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.slug);
  push(
    'Unique slugs',
    new Set(slugs).size === slugs.length,
    new Set(slugs).size === slugs.length ? 'ok' : 'duplicates',
  );

  const cronSecret = process.env.CRON_SECRET || '';
  push('CRON_SECRET', Boolean(cronSecret), cronSecret ? 'set' : 'MISSING — QStash 401');

  const passCount = results.filter((r) => r.pass).length;
  return NextResponse.json({
    summary: `${passCount}/${results.length} checks passed`,
    allPassed: passCount === results.length,
    results,
    ranAt: new Date().toISOString(),
  });
}