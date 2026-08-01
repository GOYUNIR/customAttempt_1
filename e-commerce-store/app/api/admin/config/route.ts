import { NextResponse } from 'next/server';
import {
  createRedisClient,
  getGlobalScheduleOverride,
  saveGlobalScheduleOverride,
  getSocialProofOverride,
  saveSocialProofOverride,
  getProductOverride,
  saveProductOverride,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const globalScheduleOverride = await getGlobalScheduleOverride(redis);
  const socialProofOverride = await getSocialProofOverride(redis);
  const productOverrides: Record<string, any> = {};
  for (const p of GOYUNIR_STORE_SUITE.productCatalog) {
    productOverrides[p.id] = await getProductOverride(redis, p.id);
  }

  return NextResponse.json({
    baseSchedule: GOYUNIR_STORE_SUITE.dropSchedule,
    globalScheduleOverride,
    baseSocialProof: GOYUNIR_STORE_SUITE.socialProof,
    socialProofOverride,
    products: GOYUNIR_STORE_SUITE.productCatalog.map((p) => ({
      id: p.id, name: p.name, price50ml: p.price50ml, price100ml: p.price100ml,
    })),
    productOverrides,
  });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (password !== process.env.ADMIN_BASIC_AUTH_PASSWORD) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const section = String(body?.section || '');

  if (section === 'schedule') {
    await saveGlobalScheduleOverride(redis, body.value || {});
    return NextResponse.json({ success: true });
  }
  if (section === 'socialProof') {
    await saveSocialProofOverride(redis, body.value || {});
    return NextResponse.json({ success: true });
  }
  if (section === 'product') {
    const productId = String(body?.productId || '');
    if (!productId) return NextResponse.json({ error: 'Missing productId' }, { status: 400 });
    await saveProductOverride(redis, productId, body.value || {});
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Unknown section' }, { status: 400 });
}