import { NextResponse } from 'next/server';
import {
  createRedisClient,
  archiveProductToCatalog,
  unarchiveProductFromCatalog,
  getLiveProductState,
  setLiveProductState,
} from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getAvailableSizes } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

function primarySize() {
  return getAvailableSizes(GOYUNIR_STORE_SUITE)[0] || '50ml';
}

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Database offline.' }, { status: 500 });

    const body = await request.json();
    const { action, productId, name, image, description, availableFrom, notes, verificationKey } = body;

    const masterPassword = process.env.ADMIN_BASIC_AUTH_PASSWORD;
    if (!masterPassword || verificationKey !== masterPassword) {
      return NextResponse.json({ error: '⚠️ ACCESS REJECTED: Invalid master operation password.' }, { status: 403 });
    }
    if (!productId) return NextResponse.json({ error: 'Missing product identification.' }, { status: 400 });

    const productDefinition = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.id === productId);

    if (action === 'unarchive') {
      await unarchiveProductFromCatalog(redis, String(productId));
      return NextResponse.json({ success: true });
    }

    if (action === 'set-active') {
      // Toggle between Active and Hidden — no redeploy needed.
      if (!productDefinition) return NextResponse.json({ error: 'Unknown product.' }, { status: 400 });
      const size = primarySize();
      const live = await getLiveProductState(redis, productDefinition.id, size, {
        isActive: productDefinition.isActive !== false,
        totalInventory: productDefinition.totalInventory ?? productDefinition.maxRaffleAllocationLimit ?? 10,
        winnersPerDraw: productDefinition.winnerTiers?.length ? productDefinition.winnerTiers : [productDefinition.maxRaffleAllocationLimit ?? 1],
      });
      live.isActive = Boolean(body.isActive);
      await setLiveProductState(redis, live);
      return NextResponse.json({ success: true, isActive: live.isActive });
    }

    if (action === 'update-inventory') {
      // Admin-editable inventory total + winner tiers, without touching code.
      if (!productDefinition) return NextResponse.json({ error: 'Unknown product.' }, { status: 400 });
      const size = primarySize();
      const live = await getLiveProductState(redis, productDefinition.id, size, {
        isActive: productDefinition.isActive !== false,
        totalInventory: productDefinition.totalInventory ?? productDefinition.maxRaffleAllocationLimit ?? 10,
        winnersPerDraw: productDefinition.winnerTiers?.length ? productDefinition.winnerTiers : [productDefinition.maxRaffleAllocationLimit ?? 1],
      });
      const newTotal = Number(body.totalInventory);
      const newRemaining = Number(body.inventoryRemaining);
      const newTiers = Array.isArray(body.winnerTiers)
        ? body.winnerTiers.map((n: any) => Math.max(0, Number(n) || 0)).filter((n: number) => n > 0)
        : null;
      if (Number.isFinite(newTotal) && newTotal >= 0) live.totalInventory = newTotal;
      if (Number.isFinite(newRemaining) && newRemaining >= 0) live.inventoryRemaining = newRemaining;
      if (newTiers && newTiers.length) live.winnersPerDraw = newTiers;
      await setLiveProductState(redis, live);
      return NextResponse.json({ success: true, live });
    }

    // 'archive' — writes/overwrites the catalog archive record, notes included.
    await archiveProductToCatalog(redis, {
      productId: String(productId),
      name: String(name || productId),
      image: image ? String(image) : undefined,
      description: description ? String(description) : undefined,
      availableFrom: String(availableFrom || 'Unknown'),
      archivedAt: new Date().toISOString(),
      notes: typeof notes === 'string' ? notes : undefined,
    });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}