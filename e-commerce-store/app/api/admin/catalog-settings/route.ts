import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, STORE_CONFIG_KEY, PRODUCTS_KEY} from '@/lib/server-config';
import { adminAuthorized } from '@/lib/admin-verify';
import { normalizeCategories, filterStaleCatalogEntries } from '@/lib/storefront-config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await adminAuthorized(request))) {
    return NextResponse.json({ upcomingDrops: [], archiveScents: [] });
  }
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ upcomingDrops: [], archiveScents: [] });

  // Catalog groupings are stored inside store:config.catalogPreview (single
  // source of truth) — shared with the admin Settings tab.
  const raw = await redis.get(STORE_CONFIG_KEY);
  const config = safeParseRedisItem<any>(raw) || {};
  const preview = config.catalogPreview || {};
  // Same stale-entry reconciliation as /api/catalog/status: auto-created
  // entries for products that no longer exist (deleted) are dropped so the
  // Catalog tab shows a clean list — and the next "Save Catalog Settings"
  // purges them from Redis permanently. Manual entries (no slug) are kept.
  const allRaw = await redis.hgetall(PRODUCTS_KEY);
  const products: any[] = [];
  if (allRaw) {
    for (const value of Object.values(allRaw)) {
      const product = safeParseRedisItem<any>(value);
      if (product) products.push(product);
    }
  }
  return NextResponse.json({
    upcomingDrops: filterStaleCatalogEntries(preview.upcomingDrops, products),
    archiveScents: filterStaleCatalogEntries(preview.archiveScents, products),
  });
}

export async function POST(request: Request) {
  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

  const body = await request.json();
  const password = String(body?.password || '');
  if (!(await adminAuthorized(request, password))) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }

  const upcomingDrops = Array.isArray(body?.upcomingDrops) ? body.upcomingDrops : [];
  const archiveScents = Array.isArray(body?.archiveScents) ? body.archiveScents : [];

  // Read-modify-write store:config so non-catalog settings are preserved.
  const raw = await redis.get(STORE_CONFIG_KEY);
  const current = safeParseRedisItem<any>(raw) || {};
  // The Catalog tab also carries the admin-managed category list — persist it
  // when the client sends one (an EMPTY array is valid: it means the operator
  // deleted every category). Undefined (older clients) preserves what's saved.
  const categories =
    typeof body?.categories !== 'undefined'
      ? normalizeCategories(body.categories)
      : (Array.isArray(current.catalog?.categories) ? current.catalog.categories : []);
  await redis.set(
    STORE_CONFIG_KEY,
    JSON.stringify({
      ...current,
      catalogPreview: { upcomingDrops, archiveScents },
      catalog: { ...(current.catalog || {}), categories },
      updatedAt: new Date().toISOString(),
    }),
  );
  return NextResponse.json({ success: true });
}