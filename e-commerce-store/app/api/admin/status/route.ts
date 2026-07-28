import { NextResponse } from 'next/server';
import { createRedisClient, createStripeClient, getFallbackEntries } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export async function GET() {
  const redis = createRedisClient();
  const stripe = createStripeClient();

  const status: Record<string, unknown> = {
    stripeConfigured: Boolean(stripe),
    redisConfigured: Boolean(redis),
    fallbackEntriesCount: getFallbackEntries().length,
    fallbackEntries: getFallbackEntries().slice(0, 50),
    pools: [],
    lastDraw: null,
  };

  // pool counts from Redis if available
  const pools: Array<Record<string, unknown>> = [];
  if (redis) {
    for (const product of GOYUNIR_STORE_SUITE.productCatalog) {
      for (const size of ['50ml', '100ml']) {
        const poolKey = `drop_pool:${product.name}:${size}`;
        try {
          // @ts-ignore
          const count = await redis.llen(poolKey);
          pools.push({ product: product.name, size, count });
        } catch {
          pools.push({ product: product.name, size, count: null });
        }
      }
    }
  }

  status.pools = pools;

  try {
    // @ts-ignore
    if (typeof globalThis !== 'undefined') status.lastDraw = globalThis.__goyunirLastDraw ?? null;
  } catch {}
  try {
    // @ts-ignore
    if (typeof globalThis !== 'undefined') status.lastWebhook = globalThis.__goyunirLastWebhook ?? null;
  } catch {}

  try {
    // @ts-ignore
    if (typeof globalThis !== 'undefined') status.webhookErrors = globalThis.__goyunirWebhookErrors ?? [];
  } catch {}

  return NextResponse.json(status);
}
