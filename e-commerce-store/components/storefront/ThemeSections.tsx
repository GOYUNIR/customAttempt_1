'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { sortSections, type ThemeSection } from '@/lib/theme-schema';

/**
 * THEME SECTIONS — the storefront renderer for a tenant's activated theme
 * (`lib/theme-read.ts`'s `readActiveTheme`). Additive/opt-in: a tenant with
 * no active theme row never reaches this component at all — `app/page.tsx`
 * falls back to the existing, unmodified legacy homepage. `ProductGrid`
 * fetches the REAL catalog via the same `/api/store` endpoint and cache
 * every other storefront surface already uses, so it shows real products,
 * never placeholders.
 */

const WRAP: React.CSSProperties = { minHeight: '100vh', background: '#0a0a0c', color: '#e5e5e8', fontFamily: 'system-ui, sans-serif' };

export default function ThemeSections({ sections }: { sections: ThemeSection[] }) {
  const ordered = sortSections(sections);
  return (
    <main style={WRAP}>
      {ordered.map((section) => {
        switch (section.type) {
          case 'hero':
            return <Hero key={section.id} config={section.config} />;
          case 'product_grid':
            return <ProductGrid key={section.id} config={section.config} />;
          case 'banner':
            return <Banner key={section.id} config={section.config} />;
          case 'countdown':
            return <Countdown key={section.id} config={section.config} />;
          case 'footer':
            return <Footer key={section.id} config={section.config} />;
          default:
            return null;
        }
      })}
    </main>
  );
}

export function Hero({ config }: { config: Record<string, unknown> }) {
  const title = String(config.title || 'Welcome');
  const subtitle = String(config.subtitle || '');
  const imageUrl = String(config.imageUrl || '');
  const ctaLabel = String(config.ctaLabel || 'Shop now');
  const ctaHref = String(config.ctaHref || '/catalog');
  return (
    <section
      style={{
        position: 'relative',
        minHeight: 420,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '48px 24px',
        backgroundImage: imageUrl ? `linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.55)), url(${imageUrl})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center' }}>
        <h1 style={{ fontSize: 36, margin: '0 0 12px', fontFamily: 'Georgia, serif' }}>{title}</h1>
        {subtitle && <p style={{ fontSize: 15, color: '#ccc', margin: '0 0 20px', lineHeight: 1.6 }}>{subtitle}</p>}
        <Link href={ctaHref} prefetch={false} style={{ display: 'inline-block', padding: '12px 24px', borderRadius: 999, background: '#fff', color: '#111', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
          {ctaLabel}
        </Link>
      </div>
    </section>
  );
}

export function ProductGrid({ config }: { config: Record<string, unknown> }) {
  const heading = String(config.heading || 'Featured');
  const columns = Math.min(3, Math.max(1, Number(config.columns) || 2));
  const categoryFilter = String(config.categoryFilter || '').trim().toLowerCase();
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetchStoreJson<{ allProducts?: any[] }>('/api/store')
      .then((data) => {
        if (!alive) return;
        const all = Array.isArray(data?.allProducts) ? data.allProducts : [];
        let visible = all.filter((p: any) => p.isActive === true && p.isArchived !== true && p.isUpcoming !== true);
        if (categoryFilter) {
          visible = visible.filter((p: any) => (p.categories || []).some((c: string) => String(c).toLowerCase() === categoryFilter));
        }
        setProducts(visible);
      })
      .catch(() => setProducts([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [categoryFilter]);

  return (
    <section style={{ padding: '32px 24px', maxWidth: 1080, margin: '0 auto' }}>
      <h2 style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: '#93c5fd', marginBottom: 16 }}>{heading}</h2>
      {loading && <p style={{ fontSize: 12, color: '#888' }}>Loading…</p>}
      {!loading && products.length === 0 && <p style={{ fontSize: 12, color: '#666' }}>No products live right now.</p>}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 16 }}>
        {products.map((product) => (
          <Link key={product.id} href={`/${product.slug}`} prefetch={false} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div style={{ borderRadius: 16, overflow: 'hidden', border: '1px solid #24242a', background: '#141417' }}>
              <div style={{ height: 180, background: product.images?.[0] ? `url(${product.images[0]}) center/cover` : '#1a1a1a' }} />
              <div style={{ padding: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{product.name}</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{product.tagline || product.desc}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function Banner({ config }: { config: Record<string, unknown> }) {
  const text = String(config.text || '');
  const linkHref = String(config.linkHref || '');
  const color = String(config.color || '#111111');
  if (!text) return null;
  const content = (
    <div style={{ padding: '14px 24px', background: color, color: '#fff', textAlign: 'center', fontSize: 13, fontWeight: 600 }}>{text}</div>
  );
  return linkHref ? (
    <Link href={linkHref} prefetch={false} style={{ textDecoration: 'none', display: 'block' }}>
      {content}
    </Link>
  ) : (
    content
  );
}

export function Countdown({ config }: { config: Record<string, unknown> }) {
  const heading = String(config.heading || 'Next drop');
  return (
    <section style={{ padding: '24px', textAlign: 'center' }}>
      <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: '#93c5fd' }}>{heading}</div>
      <p style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
        Live countdown timing follows each product&apos;s own drop schedule — visit a product page for the exact clock.
      </p>
    </section>
  );
}

export function Footer({ config }: { config: Record<string, unknown> }) {
  const copy = String(config.copy || '');
  return (
    <footer style={{ padding: '24px', borderTop: '1px solid #24242a', textAlign: 'center', fontSize: 11, color: '#666' }}>
      {copy || `© ${new Date().getFullYear()}`}
    </footer>
  );
}
