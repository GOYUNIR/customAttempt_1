/**
 * Catalog-entry + category helpers — self-contained (NO `@/` imports, only
 * relative paths) so `node --test` can load this module directly. The app
 * imports them through `@/lib/storefront-config` (which re-exports everything
 * here) so the storefront, admin and API routes never change their import
 * paths. Keep this module dependency-free.
 *
 * These power the "deleted products stop rendering in Upcoming/Archives" and
 * "deleted categories disappear from products" behaviors.
 */

/**
 * Normalize an arbitrary value into a clean category list: trim, dedupe
 * (case-insensitive, first occurrence wins), strip entries longer than 40
 * chars, and keep at most the first 60 entries. Never throws.
 */
export function normalizeCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const clean = String(raw ?? '').trim();
    if (!clean || clean.length > 40) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * Product category tags that are still LIVE on the storefront. A product keeps
 * its tags forever (deleting a category never destroys them on the product
 * record), but only tags that still exist in the admin-managed category list
 * are rendered as chips — so a deleted category disappears from every
 * customer-facing surface immediately, and comes back if the operator re-adds
 * the category. Products can only ever be tagged with entries from that list
 * (the admin picker only offers it), so nothing valid is ever hidden.
 */
export function visibleProductCategories(tags: unknown, adminCategories: unknown): string[] {
  const admin = new Set(normalizeCategories(adminCategories).map((c) => c.toLowerCase()));
  return normalizeCategories(tags).filter((c) => admin.has(c.toLowerCase()));
}

/**
 * Drop STALE auto-created catalogPreview entries — i.e. entries for products
 * that have been DELETED from store:products. Auto entries (written by
 * /api/admin/products when a product is saved/archived) always carry the
 * product's `slug`; manual entries added in the admin Catalog tab have NO slug
 * (that UI only has name/ETA/image/description). So an entry with a non-empty
 * slug whose slug/name no longer resolves to any product is stale. This
 * self-heals both entries orphaned by the old delete bug AND entries tagged
 * with an id that no longer exists — without ever touching intentional manual
 * entries.
 */
export function filterStaleCatalogEntries(items: unknown, products: unknown[]): any[] {
  if (!Array.isArray(items)) return [];
  const keys = new Set(
    products.flatMap((p: any) =>
      [String(p?.slug || '').trim().toLowerCase(), String(p?.name || '').trim().toLowerCase()].filter(Boolean),
    ),
  );
  return items.filter((item: any) => {
    const slug = String(item?.slug || '').trim().toLowerCase();
    if (!slug) return true; // manual entry (no slug field) — always keep
    const name = String(item?.name || '').trim().toLowerCase();
    return keys.has(slug) || keys.has(name);
  });
}
