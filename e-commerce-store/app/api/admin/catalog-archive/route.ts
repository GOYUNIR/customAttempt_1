import { NextResponse } from 'next/server';
import {
  createRedisClient,
  archiveProductToCatalog,
  unarchiveProductFromCatalog,
  getLiveProductState,
  setLiveProductState,
} from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getAvailableSizes, getWinnerCount } from '@/lib/storefront-config';
import { appendAudit } from '@/app/api/admin/audit/route';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline.' }, { status: 500 });

    const body = await request.json();
    const verificationKey = String(body?.verificationKey || body?.password || '');
    if (!(await adminAuthorized(request, verificationKey))) {
      return NextResponse.json({ error: 'Invalid password.' }, { status: 403 });
    }

    const action = String(body?.action || '');
    const productId = String(body?.productId || '');
    if (!productId || (action !== 'archive' && action !== 'unarchive')) {
      return NextResponse.json({ error: 'Invalid action or productId.' }, { status: 400 });
    }

    const productDefinition = GOYUNIR_STORE_SUITE.productCatalog.find((p) => p.id === productId);
    if (!productDefinition) {
      return NextResponse.json({ error: 'Unknown product.' }, { status: 404 });
    }

    if (action === 'archive') {
      const name = String(body?.name || productDefinition.name);
      const description = String(body?.description || productDefinition.desc || '');
      const image =
        String(body?.image || '') ||
        productDefinition.catalogImage ||
        `/images/${productDefinition.prefix}/1.jpeg`;
      const availableFrom = String(body?.availableFrom || 'Unknown');
      const notes = String(body?.notes || '');

      await archiveProductToCatalog(redis, {
        productId: productDefinition.id,
        name,
        image,
        description,
        availableFrom,
        archivedAt: new Date().toISOString(),
        notes,
      });

      // Mark ops:live_state inactive for all sizes (hands-free consistency)
      for (const size of getAvailableSizes(GOYUNIR_STORE_SUITE)) {
        try {
          const winners = getWinnerCount(GOYUNIR_STORE_SUITE, size);
          const live = await getLiveProductState(redis, productDefinition, size, winners);
          live.isActive = false;
          await setLiveProductState(redis, live);
        } catch {}
      }

      try {
        await appendAudit(redis, { action: 'PRODUCT_ARCHIVED', detail: `${name} (${productDefinition.id})`, actor: 'admin' });
      } catch {}
      return NextResponse.json({ success: true, action: 'archive', productId: productDefinition.id });
    }

    // unarchive
    await unarchiveProductFromCatalog(redis, productDefinition.id);
    for (const size of getAvailableSizes(GOYUNIR_STORE_SUITE)) {
      try {
        const winners = getWinnerCount(GOYUNIR_STORE_SUITE, size);
        const live = await getLiveProductState(redis, productDefinition, size, winners);
        live.isActive = true;
        await setLiveProductState(redis, live);
      } catch {}
    }

    try {
      await appendAudit(redis, { action: 'PRODUCT_UNARCHIVED', detail: `${productDefinition.name} (${productDefinition.id})`, actor: 'admin' });
    } catch {}
    return NextResponse.json({ success: true, action: 'unarchive', productId: productDefinition.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}