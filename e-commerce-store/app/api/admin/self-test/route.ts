import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, loadProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
  if (!master || password !== master) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const results: any[] = [];
  const push = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // Environment variables
  const envVars = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ADMIN_BASIC_AUTH_USERNAME', 'ADMIN_BASIC_AUTH_PASSWORD', 'CRON_SECRET'];
  for (const key of envVars) {
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
    } catch (e: any) { push('Redis ping', false, e.message); }
  }
  if (stripe) {
    try {
      await stripe.balance.retrieve();
      push('Stripe API', true, 'ok');
    } catch (e: any) { push('Stripe API', false, e.message); }
  }

  // Check products from Redis with priceCategories
  if (redis) {
    const allProducts = await loadProducts(redis);
    const productList = Object.values(allProducts);
    for (const product of productList) {
      const cats = product.priceCategories || [];
      for (const cat of cats) {
        const price = cat.price || 0;
        const stripeId = cat.stripeId || '';
        push(`${product.name} ${cat.size}: price`, price > 0, `$${price}`);
        push(`${product.name} ${cat.size}: Stripe ID`, Boolean(stripeId), stripeId || 'MISSING');
      }
    }
  }

  const passCount = results.filter(r => r.pass).length;
  return NextResponse.json({
    summary: `${passCount}/${results.length} checks passed`,
    allPassed: passCount === results.length,
    results,
    ranAt: new Date().toISOString(),
  });
}