import { NextResponse } from 'next/server';
import { createRedisClient, getGlobalScheduleOverride, getAllProductOverrides } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { withTtlCache } from '@/lib/ttl-cache';

export const dynamic = 'force-dynamic';

export async function GET() {
  const payload = await withTtlCache('config:public:v1', 30_000, async () => {
    const redis = createRedisClient();
    if (!redis) {
      return { globalScheduleOverride: null, productOverrides: {} };
    }
    const globalScheduleOverride = await getGlobalScheduleOverride(redis);
    const productOverrides = await getAllProductOverrides(redis, GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.id));
    return { globalScheduleOverride, productOverrides };
  });
  return NextResponse.json(payload);
}