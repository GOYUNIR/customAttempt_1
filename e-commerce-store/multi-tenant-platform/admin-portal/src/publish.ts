/**
 * The Admin Portal's "Save / Publish Changes" pipeline:
 *
 *   1. Write the updated site_settings (name + theme + layout blocks) and the
 *      product catalog straight into Supabase Postgres (service role).
 *   2. Flip `sites.is_published`.
 *   3. Purge the tenant's Cloudflare KV cache keys immediately, so the next
 *      visitor is served the freshly compiled payload (the Worker re-warms KV
 *      on the following miss).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, PublishSiteInput } from '../../shared/types.ts';
import { cacheKeyForSite, normalizeHostname } from '../../shared/hostname.ts';
import { deleteKvKeys, type CloudflareBulkResult, type CloudflareCredentials } from './cloudflare-kv.ts';

export interface PublishResult {
  siteId: string;
  productsWritten: number;
  published: boolean;
  cacheKeys: string[];
  cachePurged: CloudflareBulkResult;
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

/**
 * Every KV key that must be invalidated for a site. The `cacheVersion` must
 * match the Worker's CACHE_VERSION (multi-tenant-platform/worker/wrangler.toml)
 * so the deleted keys are the keys the Worker actually reads.
 */
export function buildCacheKeysForSite(input: PublishSiteInput, cacheVersion: number): string[] {
  const keys = new Set<string>();
  const subdomain = input.subdomain.trim().toLowerCase();
  if (subdomain) keys.add(cacheKeyForSite(subdomain, cacheVersion));
  if (input.customDomain) {
    const normalized = normalizeHostname(input.customDomain);
    // The Worker treats `www.` as an alias of the bare domain — purge the key
    // the Worker actually reads, not the one the visitor typed.
    const withoutWww = normalized.startsWith('www.') ? normalized.slice(4) : normalized;
    if (withoutWww) keys.add(cacheKeyForSite(withoutWww, cacheVersion));
  }
  return [...keys];
}

export async function publishSite(
  admin: SupabaseClient<Database>,
  kv: CloudflareCredentials,
  input: PublishSiteInput,
  cacheVersion: number,
): Promise<PublishResult> {
  // 1) Write the updated settings to Postgres (service role bypasses RLS).
  const { error: settingsError } = await admin.from('site_settings').upsert(
    {
      site_id: input.siteId,
      site_name: input.siteName,
      theme_config: input.themeConfig,
      layout_blocks: input.layoutBlocks,
    },
    { onConflict: 'site_id' },
  );
  if (settingsError) throw new PublishError(`site_settings write failed: ${settingsError.message}`);

  // 2) Replace the catalog. Deterministic admin semantic: delete the site's
  //    products, then insert the draft set with a fresh sort order.
  const { error: deleteError } = await admin.from('products').delete().eq('site_id', input.siteId);
  if (deleteError) throw new PublishError(`products delete failed: ${deleteError.message}`);

  const rows = input.products.map((product, index) => ({
    site_id: input.siteId,
    name: product.name,
    description: product.description,
    price: product.price,
    image_url: product.imageUrl,
    is_active: product.isActive,
    sort_order: index,
    tags: product.tags,
  }));

  if (rows.length > 0) {
    const { error: insertError } = await admin.from('products').insert(rows);
    if (insertError) throw new PublishError(`products insert failed: ${insertError.message}`);
  }

  // 3) Flip the publish state.
  const { error: siteError } = await admin
    .from('sites')
    .update({ is_published: input.isPublished })
    .eq('id', input.siteId);
  if (siteError) throw new PublishError(`sites update failed: ${siteError.message}`);

  // 4) Invalidate Cloudflare KV so the live site updates instantly.
  const cacheKeys = buildCacheKeysForSite(input, cacheVersion);
  const cachePurged = await deleteKvKeys(kv, cacheKeys);

  return {
    siteId: input.siteId,
    productsWritten: rows.length,
    published: input.isPublished,
    cacheKeys,
    cachePurged,
  };
}
