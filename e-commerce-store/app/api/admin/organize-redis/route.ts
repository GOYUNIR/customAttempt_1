import { NextResponse } from 'next/server';
import { createRedisClient, getAdminPassword, safeParseRedisItem } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

// ============================================================
// REDIS CLEANUP — removes legacy redundant keys.
//
// The store has a single source of truth for products (`store:products`) and
// settings (`store:config`). These legacy keys were mirror copies or
// duplicates that used to be kept in sync on every write:
//   - store:active_products / store:archived_products / store:upcoming_products
//       Full JSON copies of products already stored in store:products.
//       The storefront derives these by filtering product flags at read time.
//   - store:product_images:* — copies of the images array already embedded in
//       each product object.
//   - store:catalog_config — a third copy of catalog groupings now stored in
//       store:config.catalogPreview.
// ============================================================
const MIRROR_KEYS = [
  'store:active_products',
  'store:archived_products',
  'store:upcoming_products',
];
const CATALOG_CONFIG_KEY = 'store:catalog_config';
const PRODUCT_IMAGES_PREFIX = 'store:product_images:';

export async function POST(request: Request) {
  try {
    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const body = await request.json();
    const password = String(body?.password || '');
    const master = getAdminPassword() || '';
    if (!master || password !== master) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const removed: string[] = [];

    // 1) Drop the product mirror hashes (full duplicate payloads).
    for (const key of MIRROR_KEYS) {
      const exists = await redis.exists(key);
      if (exists) {
        await redis.del(key);
        removed.push(key);
      }
    }

    // 2) Drop the standalone per-product image keys (images live in products).
    const imageKeys = await redis.keys(`${PRODUCT_IMAGES_PREFIX}*`);
    if (Array.isArray(imageKeys) && imageKeys.length > 0) {
      await redis.del(...imageKeys);
      removed.push(`${PRODUCT_IMAGES_PREFIX}* (${imageKeys.length} keys)`);
    }

    // 3) Migrate then drop the legacy catalog config copy. Manual entries
    //    edited in the admin Catalog tab are folded into store:config.catalogPreview
    //    (the canonical location) so nothing is lost before the old key is removed.
    const catalogExists = await redis.exists(CATALOG_CONFIG_KEY);
    if (catalogExists) {
      const legacyCatalog = safeParseRedisItem<any>(await redis.get(CATALOG_CONFIG_KEY)) || {};
      const configRaw = await redis.get('store:config');
      const storeConfig = safeParseRedisItem<any>(configRaw) || {};
      const preview = storeConfig.catalogPreview || {};
      const upcomingDrops = Array.isArray(preview.upcomingDrops) ? preview.upcomingDrops : [];
      const archiveScents = Array.isArray(preview.archiveScents) ? preview.archiveScents : [];
      const legacyUpcoming = Array.isArray(legacyCatalog.upcomingDrops) ? legacyCatalog.upcomingDrops : [];
      const legacyArchive = Array.isArray(legacyCatalog.archiveScents) ? legacyCatalog.archiveScents : [];
      const dedupeBySlug = (items: any[]) =>
        items.filter((item, index, all) => all.findIndex((other) => String(other.slug || other.name) === String(item.slug || item.name)) === index);
      const migratedUpcoming = dedupeBySlug([...upcomingDrops, ...legacyUpcoming]);
      const migratedArchive = dedupeBySlug([...archiveScents, ...legacyArchive]);
      const merged = {
        ...storeConfig,
        catalogPreview: { upcomingDrops: migratedUpcoming, archiveScents: migratedArchive },
        updatedAt: new Date().toISOString(),
      };
      if (JSON.stringify(merged) !== configRaw) {
        await redis.set('store:config', JSON.stringify(merged));
      }
      await redis.del(CATALOG_CONFIG_KEY);
      removed.push(`${CATALOG_CONFIG_KEY} (migrated into store:config.catalogPreview)`);
    }

    return NextResponse.json({
      success: true,
      message: removed.length > 0 ? `Removed ${removed.length} redundant key group(s).` : 'Nothing to clean — Redis is already tidy.',
      removed,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Unable to clean up Redis' }, { status: 500 });
  }
}
