import { NextResponse } from 'next/server';
import {
  createRedisClient,
  getLiveProductState,
  setLiveProductState,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getWinnerCount } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline.' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    const master = process.env.ADMIN_BASIC_AUTH_PASSWORD || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password.' }, { status: 403 });
    }

    const productName = String(body?.productName || '');
    const size = String(body?.size || '50ml');
    const inventoryRemaining = Number(body?.inventoryRemaining);
    if (!productName || !Number.isFinite(inventoryRemaining) || inventoryRemaining < 0) {
      return NextResponse.json({ error: 'Invalid payload.' }, { status: 400 });
    }

    const product = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.name === productName);
    if (!product) return NextResponse.json({ error: 'Unknown product.' }, { status: 404 });

    const winners = getWinnerCount(GOYUNIR_STORE_SUITE, size);
    const live = await getLiveProductState(redis, product, size, winners);
    live.inventoryRemaining = Math.floor(inventoryRemaining);
    if (live.inventoryRemaining > live.totalInventory) {
      live.totalInventory = live.inventoryRemaining;
    }
    await setLiveProductState(redis, live);

    return NextResponse.json({ success: true, live });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}