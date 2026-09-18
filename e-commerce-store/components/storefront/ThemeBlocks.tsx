'use client';

import Link from 'next/link';
import { sortSections, type ThemeSection } from '@/lib/theme-schema';
import { Hero, ProductGrid, Banner, Countdown, Footer } from '@/components/storefront/ThemeSections';

/**
 * THEME BLOCKS — the renderers for the product-detail, catalog and shared
 * sections, plus the one switch that can draw ANY section type.
 *
 * The theme system could previously only style the HOMEPAGE: five section
 * types, one page, while the product page and the catalog — most of what a
 * shopper actually looks at — were hardcoded. `lib/theme-templates.ts` made a
 * three-page template expressible; this is what draws it.
 *
 * Each block takes the `config` a starter template writes, plus the product or
 * product list THE PAGE ALREADY LOADED. Nothing here refetches data the caller
 * has in hand, so a themed page costs no more requests than a hardcoded one.
 *
 * The original five renderers are imported rather than reimplemented: a section
 * that looked one way in the homepage and another on a product page would make
 * the whole theme system untrustworthy.
 */

export type ThemeRenderContext = {
  product?: Record<string, unknown> | null;
  products?: Array<Record<string, unknown>> | null;
};

const PAD: React.CSSProperties = { padding: '28px 24px' };
const MUTED = '#8b8b93';
const STAR = String.fromCharCode(9733);

function ProductGallery({ config, ctx }: { config: Record<string, unknown>; ctx: ThemeRenderContext }) {
  const images = Array.isArray(ctx.product?.images) ? (ctx.product!.images as string[]) : [];
  const cover = images[0] || String(ctx.product?.coverImage || '');
  return (
    <section style={PAD}>
      {cover ? (
        <img src={cover} alt={String(ctx.product?.name || 'Product')} style={{ width: '100%', borderRadius: 14, display: 'block', objectFit: 'cover', maxHeight: 520 }} />
      ) : (
        <div style={{ width: '100%', height: 320, borderRadius: 14, background: '#17171c' }} />
      )}
      {config.showThumbnails !== false && images.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto' }}>
          {images.slice(0, 8).map((src, i) => (
            <img key={src + i} src={src} alt="" style={{ width: 64, height: 64, borderRadius: 8, objectFit: 'cover', flex: '0 0 auto' }} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProductSummary({ config, ctx }: { config: Record<string, unknown>; ctx: ThemeRenderContext }) {
  const p = ctx.product || {};
  const priceCents = Number(p.priceCents ?? p.price_cents ?? 0);
  const remaining = Number(p.inventoryRemaining ?? p.remaining ?? NaN);
  return (
    <section style={PAD}>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 8px' }}>{String(p.name || 'Product')}</h1>

      {/* showPrice is FALSE for B2B: contract pricing means the list price is
          not what that buyer pays, so showing it would mislead them. */}
      {config.showPrice !== false && priceCents > 0 && (
        <p style={{ fontSize: 19, fontWeight: 700, margin: '0 0 10px' }}>${(priceCents / 100).toFixed(2)}</p>
      )}

      {config.showStock !== false && Number.isFinite(remaining) && (
        <p style={{ fontSize: 13, color: MUTED, margin: '0 0 6px' }}>
          {remaining > 0 ? remaining + ' available' : 'Sold out'}
        </p>
      )}

      {/* Urgency is opt-IN per template, never a default. On an always-in-stock
          product it is a claim the customer disproves by reloading the page;
          only a genuinely limited allocation turns it on. */}
      {config.showUrgency === true && Number.isFinite(remaining) && remaining > 0 && remaining <= 10 && (
        <p style={{ fontSize: 13, color: '#fbbf24', margin: '0 0 10px' }}>Only {remaining} left in this release</p>
      )}

      <button type="button" style={{ background: '#f4f4f5', color: '#0a0a0c', border: 'none', borderRadius: 999, padding: '13px 24px', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
        {String(config.ctaLabel || 'Add to cart')}
      </button>
    </section>
  );
}

function ProductDetails({ config, ctx }: { config: Record<string, unknown>; ctx: ThemeRenderContext }) {
  const p = ctx.product || {};
  const description = String(p.description || p.tagline || '');
  const specs = (p.specs && typeof p.specs === 'object' ? p.specs : {}) as Record<string, unknown>;
  const entries = Object.entries(specs).slice(0, 20);
  return (
    <section style={PAD}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 10px' }}>{String(config.heading || 'Details')}</h2>
      {description && <p style={{ fontSize: 14, lineHeight: 1.65, color: MUTED, margin: '0 0 14px' }}>{description}</p>}
      {config.showSpecs !== false && entries.length > 0 && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 18px', fontSize: 13.5, margin: 0 }}>
          {entries.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ color: MUTED }}>{k}</dt>
              <dd style={{ margin: 0 }}>{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function ProductReviews({ config, ctx }: { config: Record<string, unknown>; ctx: ThemeRenderContext }) {
  const reviews = Array.isArray(ctx.product?.reviews) ? (ctx.product!.reviews as Array<Record<string, unknown>>) : [];
  // Below the threshold this renders NOTHING rather than an empty "no reviews
  // yet" box. A product with one review and a loud empty state looks worse than
  // one that simply does not mention reviews.
  if (reviews.length < Math.max(0, Number(config.minToDisplay ?? 1))) return null;
  return (
    <section style={PAD}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>{String(config.heading || 'Reviews')}</h2>
      <div style={{ display: 'grid', gap: 12 }}>
        {reviews.slice(0, 10).map((r, i) => (
          <div key={i} style={{ border: '1px solid #24242a', borderRadius: 12, padding: '12px 14px' }}>
            <div style={{ fontSize: 12, color: '#fbbf24' }}>{STAR.repeat(Math.max(0, Math.min(5, Number(r.rating) || 0)))}</div>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: '6px 0 0' }}>{String(r.body || '')}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CatalogHeader({ config, ctx }: { config: Record<string, unknown>; ctx: ThemeRenderContext }) {
  const count = Array.isArray(ctx.products) ? ctx.products.length : 0;
  return (
    <section style={{ ...PAD, paddingBottom: 10 }}>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 6px' }}>{String(config.heading || 'All products')}</h1>
      {String(config.blurb || '') && <p style={{ fontSize: 14, color: MUTED, margin: '0 0 6px' }}>{String(config.blurb)}</p>}
      {config.showCount !== false && count > 0 && (
        <p style={{ fontSize: 12.5, color: MUTED, margin: 0 }}>{count} {count === 1 ? 'product' : 'products'}</p>
      )}
    </section>
  );
}

function CatalogFilters({ config }: { config: Record<string, unknown> }) {
  // Which filters appear is a template decision, not cosmetics: a drop catalog
  // hides price range because most of it is closed, and a B2B catalog hides it
  // because contract pricing makes the list price meaningless.
  const chips: string[] = [];
  if (config.showCategories !== false) chips.push('Category');
  if (config.showPriceRange !== false) chips.push('Price');
  if (config.showAvailability !== false) chips.push('Availability');
  if (chips.length === 0) return null;
  return (
    <section style={{ ...PAD, paddingTop: 6, paddingBottom: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {chips.map((c) => (
        <span key={c} style={{ border: '1px solid #24242a', borderRadius: 999, padding: '7px 14px', fontSize: 12.5, color: MUTED }}>{c}</span>
      ))}
    </section>
  );
}

function CatalogGrid({ config, ctx }: { config: Record<string, unknown>; ctx: ThemeRenderContext }) {
  const products = Array.isArray(ctx.products) ? ctx.products : [];
  const columns = Math.max(1, Math.min(4, Number(config.columns) || 3));
  const minWidth = Math.floor(1000 / columns);
  if (products.length === 0) {
    return <section style={PAD}><p style={{ color: MUTED, fontSize: 14 }}>No products yet.</p></section>;
  }
  return (
    <section style={PAD}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(' + minWidth + 'px, 1fr))', gap: 16 }}>
        {products.map((p, i) => {
          const slug = String(p.slug || p.id || i);
          const priceCents = Number(p.priceCents ?? p.price_cents ?? 0);
          const cover = String(p.coverImage || '');
          return (
            <Link key={slug} href={'/' + slug} prefetch={false} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div style={{ border: '1px solid #24242a', borderRadius: 14, overflow: 'hidden' }}>
                {cover ? (
                  <img src={cover} alt={String(p.name || '')} style={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' }} />
                ) : (
                  <div style={{ width: '100%', aspectRatio: '1/1', background: '#17171c' }} />
                )}
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{String(p.name || 'Product')}</div>
                  {config.showPrice !== false && priceCents > 0 && (
                    <div style={{ fontSize: 13, color: MUTED, marginTop: 3 }}>${(priceCents / 100).toFixed(2)}</div>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function RichText({ config }: { config: Record<string, unknown> }) {
  const heading = String(config.heading || '');
  const body = String(config.body || '');
  if (!heading && !body) return null;
  return (
    <section style={PAD}>
      {heading && <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{heading}</h2>}
      {body && <p style={{ fontSize: 14, lineHeight: 1.7, color: MUTED, margin: 0, whiteSpace: 'pre-wrap' }}>{body}</p>}
    </section>
  );
}

function TrustBadges({ config }: { config: Record<string, unknown> }) {
  const items = Array.isArray(config.items) ? (config.items as unknown[]).map(String).filter(Boolean) : [];
  if (items.length === 0) return null;
  return (
    <section style={{ ...PAD, display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
      {items.map((t) => (
        <span key={t} style={{ fontSize: 12.5, color: MUTED, border: '1px solid #24242a', borderRadius: 999, padding: '8px 15px' }}>{t}</span>
      ))}
    </section>
  );
}

function Faq({ config }: { config: Record<string, unknown> }) {
  const items = Array.isArray(config.items) ? (config.items as Array<{ q?: unknown; a?: unknown }>) : [];
  if (items.length === 0) return null;
  return (
    <section style={PAD}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 12px' }}>{String(config.heading || 'Questions')}</h2>
      <div style={{ display: 'grid', gap: 10 }}>
        {items.slice(0, 20).map((item, i) => (
          <details key={i} style={{ border: '1px solid #24242a', borderRadius: 12, padding: '10px 14px' }}>
            <summary style={{ fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>{String(item.q || '')}</summary>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: MUTED, margin: '8px 0 0' }}>{String(item.a || '')}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/**
 * Draw one section of ANY type.
 *
 * Returns null only for a type with no renderer — which, with the palette
 * closed and `SECTION_PLACEMENT` covering every entry, should be unreachable.
 * It is not made to throw: a storefront must not go blank because one section
 * in a saved theme is unfamiliar to the running build.
 */
export function renderSection(sec: ThemeSection, ctx: ThemeRenderContext = {}) {
  switch (sec.type) {
    case 'hero': return <Hero key={sec.id} config={sec.config} />;
    case 'product_grid': return <ProductGrid key={sec.id} config={sec.config} />;
    case 'banner': return <Banner key={sec.id} config={sec.config} />;
    case 'countdown': return <Countdown key={sec.id} config={sec.config} />;
    case 'footer': return <Footer key={sec.id} config={sec.config} />;
    case 'product_gallery': return <ProductGallery key={sec.id} config={sec.config} ctx={ctx} />;
    case 'product_summary': return <ProductSummary key={sec.id} config={sec.config} ctx={ctx} />;
    case 'product_details': return <ProductDetails key={sec.id} config={sec.config} ctx={ctx} />;
    case 'product_reviews': return <ProductReviews key={sec.id} config={sec.config} ctx={ctx} />;
    case 'catalog_header': return <CatalogHeader key={sec.id} config={sec.config} ctx={ctx} />;
    case 'catalog_filters': return <CatalogFilters key={sec.id} config={sec.config} />;
    case 'catalog_grid': return <CatalogGrid key={sec.id} config={sec.config} ctx={ctx} />;
    case 'rich_text': return <RichText key={sec.id} config={sec.config} />;
    case 'trust_badges': return <TrustBadges key={sec.id} config={sec.config} />;
    case 'faq': return <Faq key={sec.id} config={sec.config} />;
    default: return null;
  }
}

/** Draw one page of a theme, in order. */
export default function ThemePageSections({
  sections,
  ctx,
}: {
  sections: ThemeSection[];
  ctx?: ThemeRenderContext;
}) {
  return <>{sortSections(sections).map((s) => renderSection(s, ctx || {}))}</>;
}
