import { NextResponse } from 'next/server';
import {
  createRedisClient,
  getOrSeedLiveState,
  saveLiveState,
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
    const inventoryRemaining =
      body?.inventoryRemaining !== undefined && body?.inventoryRemaining !== null
        ? Number(body.inventoryRemaining)
        : undefined;
    const totalInventory =
      body?.totalInventory !== undefined && body?.totalInventory !== null
        ? Number(body.totalInventory)
        : undefined;
    const winnersPerDraw =
      body?.winnersPerDraw !== undefined && body?.winnersPerDraw !== null
        ? Number(body.winnersPerDraw)
        : undefined;

    if (!productName) {
      return NextResponse.json({ error: 'productName required.' }, { status: 400 });
    }

    const product = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.name === productName);
    if (!product) return NextResponse.json({ error: 'Unknown product.' }, { status: 404 });

    const defaultWinners = getWinnerCount(GOYUNIR_STORE_SUITE, size);
    const live = await getOrSeedLiveState(redis, product, size, defaultWinners);

    if (inventoryRemaining !== undefined) {
      if (!Number.isFinite(inventoryRemaining) || inventoryRemaining < 0) {
        return NextResponse.json({ error: 'Invalid inventoryRemaining.' }, { status: 400 });
      }
      live.inventoryRemaining = Math.floor(inventoryRemaining);
      if (live.inventoryRemaining > live.totalInventory) {
        live.totalInventory = live.inventoryRemaining;
      }
    }

    if (totalInventory !== undefined) {
      if (!Number.isFinite(totalInventory) || totalInventory < 0) {
        return NextResponse.json({ error: 'Invalid totalInventory.' }, { status: 400 });
      }
      live.totalInventory = Math.floor(totalInventory);
      if (live.inventoryRemaining > live.totalInventory) {
        live.inventoryRemaining = live.totalInventory;
      }
    }

    if (winnersPerDraw !== undefined) {
      if (!Number.isFinite(winnersPerDraw) || winnersPerDraw < 1) {
        return NextResponse.json({ error: 'winnersPerDraw must be >= 1.' }, { status: 400 });
      }
      let w = Math.floor(winnersPerDraw);
      // Cannot select more winners than units left
      if (w > live.inventoryRemaining) {
        w = Math.max(1, live.inventoryRemaining);
      }
      if (live.inventoryRemaining === 0) {
        return NextResponse.json(
          { error: 'Inventory is 0 — restock before setting winners per draw.' },
          { status: 400 },
        );
      }
      live.winnersPerDraw = w as any;
    }

    // Re-clamp if inventory was lowered below winners
    {
      const raw = live.winnersPerDraw as any;
      const w = Array.isArray(raw) ? Number(raw[0]) || 1 : Number(raw) || 1;
      if (w > live.inventoryRemaining && live.inventoryRemaining > 0) {
        live.winnersPerDraw = live.inventoryRemaining as any;
      }
    }

    await saveLiveState(redis, live);

    return NextResponse.json({
      success: true,
      live: {
        productId: live.productId,
        inventoryRemaining: live.inventoryRemaining,
        totalInventory: live.totalInventory,
        winnersPerDraw: live.winnersPerDraw,
        salesCompleted: live.salesCompleted,
        drawsCompleted: live.drawsCompleted,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
