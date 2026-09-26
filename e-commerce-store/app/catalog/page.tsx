import LegacyCatalogPage from '@/components/storefront/LegacyCatalogPage';
import ThemePageSections from '@/components/storefront/ThemeBlocks';
import { readThemePage } from '@/lib/theme-page-read';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { storefrontTenantFromHeaders } from '@/lib/storefront-tenant';
import { notFound } from 'next/navigation';
import { createKvClient, loadProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * The catalog.
 *
 * Server-side gate, identical in shape to `app/page.tsx` and the product page:
 * a tenant whose ACTIVE THEME defines catalog sections gets the themed layout;
 * everyone else gets `LegacyCatalogPage` — the previous `app/catalog/page.tsx`,
 * moved wholesale into a component and otherwise untouched, so nothing
 * regresses for a store with no theme.
 *
 * Products are loaded here and passed in, so catalog_header can state a count
 * and catalog_grid can render without each block fetching for itself.
 */
export default async function CatalogPage() {
  // Whose store (TENANCY.md). Unknown address: 404, never the default store.
  // Themed layouts load products from the DEFAULT catalog, so only the default
  // store gets them until they are tenant-aware; other stores render the
  // standard catalog, which reads the tenant-aware /api/store.
  const who = await storefrontTenantFromHeaders();
  if (who.kind === 'none') notFound();
  if (who.kind === 'unavailable') throw new Error('[storefront] store lookup unavailable');
  const tenantId = who.isDefault ? await ensureDefaultTenant().catch(() => null) : null;
  const sections = tenantId ? await readThemePage(tenantId, 'catalog') : [];

  if (sections.length > 0) {
    const products = await loadThemedProducts();
    return (
      <main style={{ minHeight: '100vh', background: '#0a0a0c', color: '#e5e5e8', fontFamily: 'system-ui, sans-serif' }}>
        <ThemePageSections sections={sections} ctx={{ products }} />
      </main>
    );
  }

  return <LegacyCatalogPage />;
}

/** Every product for the grid. Never throws; an empty list renders the
 *  grid's own "No products yet" rather than taking the page down. */
async function loadThemedProducts(): Promise<Array<Record<string, unknown>>> {
  try {
    const kv = createKvClient();
    if (!kv) return [];
    return Object.values((await loadProducts(kv)) || {}) as Array<Record<string, unknown>>;
  } catch (err) {
    console.error('[catalog] themed product load failed', (err as Error)?.message || err);
    return [];
  }
}
