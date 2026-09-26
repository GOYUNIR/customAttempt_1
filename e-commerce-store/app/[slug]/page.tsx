import { Suspense } from 'react';
import Storefront from '@/components/Storefront';
import ThemePageSections from '@/components/storefront/ThemeBlocks';
import { readThemePage } from '@/lib/theme-page-read';
import { ensureDefaultTenant } from '@/lib/tenant-context';
import { storefrontTenantFromHeaders } from '@/lib/storefront-tenant';
import { notFound } from 'next/navigation';
import { createKvClient, loadProducts } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * The product page.
 *
 * Server-side gate, the same shape `app/page.tsx` already uses for the
 * homepage: a tenant whose ACTIVE THEME defines product-page sections gets the
 * themed layout; everyone else — the default today — gets the existing
 * `Storefront` component, byte-for-byte unchanged.
 *
 * This is what made the theme system real rather than expressible. Until now a
 * template could describe a product page and nothing would ever draw it, so the
 * PDP — where the difference between a drop, a retail item and a B2B line
 * actually shows — was hardcoded for every tenant.
 *
 * The product is loaded HERE and handed to the sections, so a themed page costs
 * the same number of round trips as the hardcoded one rather than having every
 * block fetch for itself.
 */
export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Whose store (TENANCY.md). Unknown address: 404, never the default store.
  // Themed layouts load products from the DEFAULT catalog, so only the default
  // store gets them until they are tenant-aware; other stores render the
  // standard product page, which reads the tenant-aware /api/store.
  const who = await storefrontTenantFromHeaders();
  if (who.kind === 'none') notFound();
  if (who.kind === 'unavailable') throw new Error('[storefront] store lookup unavailable');
  const tenantId = who.isDefault ? await ensureDefaultTenant().catch(() => null) : null;
  const sections = tenantId ? await readThemePage(tenantId, 'product') : [];

  if (sections.length > 0) {
    const product = await loadThemedProduct(slug);
    // A themed layout with no product to put in it would render an empty buy
    // box. Falling through to Storefront keeps its "product not found" handling,
    // which is the behaviour that already exists for a bad slug.
    if (product) {
      return (
        <main style={{ minHeight: '100vh', background: '#0a0a0c', color: '#e5e5e8', fontFamily: 'system-ui, sans-serif' }}>
          <ThemePageSections sections={sections} ctx={{ product }} />
        </main>
      );
    }
  }

  // Storefront asks for `/api/store?slug=…` only after it hydrates; start that
  // request with the HTML instead (lib/client-store-cache.ts picks it up by
  // the exact URL). JSON.stringify + the '<' escape keep the slug inert.
  const productUrl = JSON.stringify(`/api/store?slug=${slug}`).replace(/</g, '\\u003c');
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `try{var u=${productUrl};var m=window.__GOYUNIR_STORE_PREFETCHES__=window.__GOYUNIR_STORE_PREFETCHES__||{};m[u]=fetch(u).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}catch(e){}`,
        }}
      />
      <Suspense fallback={null}>
        <Storefront initialSlug={slug} />
      </Suspense>
    </>
  );
}

/** The one product this page is about, or null. Never throws. */
async function loadThemedProduct(slug: string): Promise<Record<string, unknown> | null> {
  try {
    const kv = createKvClient();
    if (!kv) return null;
    const products = Object.values((await loadProducts(kv)) || {}) as Array<Record<string, unknown>>;
    return (
      products.find((p) => String(p.slug || '') === slug) ||
      products.find((p) => String(p.id || '') === slug) ||
      null
    );
  } catch (err) {
    console.error('[product-page] themed product load failed', (err as Error)?.message || err);
    return null;
  }
}
