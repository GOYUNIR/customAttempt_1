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

  for (const key of [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'ADMIN_BASIC_AUTH_USERNAME',
    'ADMIN_BASIC_AUTH_PASSWORD',
    'CRON_SECRET',
  ]) {
    push(`Env: ${key}`, Boolean(process.env[key]), process.env[key] ? 'set' : 'MISSING');
  }
  push('Env: RESEND_API_KEY', Boolean(process.env.RESEND_API_KEY), process.env.RESEND_API_KEY ? 'set' : 'optional');
  push('Env: RESEND_FROM', Boolean(process.env.RESEND_FROM), process.env.RESEND_FROM || 'default');

  const redis = createRedisClient();
  const stripe = createStripeClient();
  push('Redis client', Boolean(redis), redis ? 'ok' : 'failed');
  push('Stripe client', Boolean(stripe), stripe ? 'ok' : 'failed');

  if (redis) {
    try {
      await redis.ping();
      push('Redis ping', true, 'pong');
    } catch (e: any) {
      push('Redis ping', false, e.message);
    }
  }
  if (stripe) {
    try {
      await stripe.balance.retrieve();
      push('Stripe API', true, 'ok');
    } catch (e: any) {
      push('Stripe API', false, e.message);
    }
  }

  for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
    try {
      const schedule = resolveProductSchedule(GOYUNIR_STORE_SUITE, product);
      const ts = getNextDrawTimestampForSchedule(schedule);
      push(`${product.name}: schedule`, Number.isFinite(ts) && ts > 0, new Date(ts).toISOString());
    } catch (e: any) {
      push(`${product.name}: schedule`, false, e.message);
    }
    for (const size of getAvailableSizes(GOYUNIR_STORE_SUITE)) {
      const price = getProductPrice(product, size);
      push(`${product.name} ${size}: price`, price > 0, `$${price}`);
    }
  }

  if (redis) {
    try {
      const records = await getCatalogArchiveRecords(redis);
      push('Catalog archive', true, `${records.length} archived`);
    } catch (e: any) {
      push('Catalog archive', false, e.message);
    }
  }

  const passCount = results.filter((r) => r.pass).length;
  return NextResponse.json({
    summary: `${passCount}/${results.length} checks passed`,
    allPassed: passCount === results.length,
    results,
    ranAt: new Date().toISOString(),
  });
}
