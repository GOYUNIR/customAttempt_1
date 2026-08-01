import { NextResponse } from 'next/server';
import { createRedisClient, getGlobalScheduleOverride, getAllProductOverrides } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ globalScheduleOverride: null, productOverrides: {} });
  }
  const globalScheduleOverride = await getGlobalScheduleOverride(redis);
  const productOverrides = await getAllProductOverrides(redis, GOYUNIR_STORE_SUITE.productCatalog.map((p) => p.id));
  return NextResponse.json({ globalScheduleOverride, productOverrides });
}