'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [activeProducts, setActiveProducts] = useState<any[]>([]);
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  useEffect(() => {
    async function checkProducts() {
      try {
        const res = await fetch('/api/store/config');
        const data = await res.json();
        const sorted = Array.isArray(data.activeProducts)
          ? [...data.activeProducts].sort((a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)))
          : [];
        setActiveProducts(sorted);
      } catch (err) {
        console.error('[HomePage] Error checking products:', err);
      } finally {
        setLoading(false);
      }
    }

    checkProducts();
  }, []);

  if (loading) {
    return (
      <main style={{ minHeight: '100vh', background: '#0a0a0a', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: '4px', textTransform: 'uppercase', color: '#666' }}>Loading live drops</div>
          <div style={{ marginTop: 12, width: 44, height: 2, background: configPalette.accentPurple, marginLeft: 'auto', marginRight: 'auto' }} />
        </div>
      </main>
    );
  }

  const primaryProduct = activeProducts[0];
  const secondaryProducts = activeProducts.slice(1);

  return (
    <main style={{ minHeight: '100vh', background: configPalette.primaryBackground, color: configPalette.textMain, padding: '24px 16px 64px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section style={{ border: `1px solid ${configPalette.cardBorder}`, borderRadius: 24, padding: '20px 18px', background: '#0e0e10' }}>
          <div style={{ fontSize: 12, letterSpacing: '4px', textTransform: 'uppercase', color: configPalette.textMuted, marginBottom: 8 }}>GOYUNIR / LIVE ACCESS</div>
          <h1 style={{ fontSize: 30, fontFamily: 'serif', margin: '0 0 10px', lineHeight: 1.1 }}>Fast launches. Premium access. Built for mobile-first hype traffic.</h1>
          <p style={{ color: '#c8c8cf', fontSize: 14, lineHeight: 1.7, margin: '0 0 16px' }}>
            The storefront is designed to feel effortless on phones, convert quickly, and let admins manage drops, pricing, and raffle timing without touching code.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link href="/catalog" style={{ padding: '10px 16px', borderRadius: 999, background: configPalette.textMain, color: configPalette.primaryBackground, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>Browse catalog</Link>
            {primaryProduct?.slug ? <Link href={`/${primaryProduct.slug}`} style={{ padding: '10px 16px', borderRadius: 999, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>Open live drop</Link> : null}
          </div>
        </section>

        {activeProducts.length > 0 ? (
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>Priority drops</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>Sorted by admin order</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {primaryProduct && (
                <Link href={`/${primaryProduct.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ borderRadius: 20, overflow: 'hidden', border: `1px solid ${configPalette.cardBorder}`, background: '#121217' }}>
                    <div style={{ height: 180, background: primaryProduct.images?.[0] ? `url(${primaryProduct.images[0]}) center/cover` : '#1a1a1a' }} />
                    <div style={{ padding: 14 }}>
                      <div style={{ fontSize: 12, color: configPalette.accentPurple, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '2px' }}>Primary release</div>
                      <div style={{ fontSize: 18, fontFamily: 'serif', marginBottom: 4 }}>{primaryProduct.name}</div>
                      <div style={{ fontSize: 12, color: '#b8b8c0', lineHeight: 1.5 }}>{primaryProduct.tagline || primaryProduct.desc}</div>
                    </div>
                  </div>
                </Link>
              )}
              {secondaryProducts.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {secondaryProducts.map((product: any) => (
                    <Link key={product.id} href={`/${product.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderRadius: 16, background: '#121217', border: `1px solid ${configPalette.cardBorder}` }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{product.name}</div>
                          <div style={{ fontSize: 11, color: configPalette.textMuted, marginTop: 2 }}>{product.tagline || product.desc}</div>
                        </div>
                        <div style={{ fontSize: 12, color: configPalette.accentBlue }}>Open →</div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : (
          <section style={{ border: `1px solid ${configPalette.cardBorder}`, borderRadius: 24, padding: '20px 18px', background: '#0e0e10' }}>
            <div style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue, marginBottom: 8 }}>No active drops</div>
            <h2 style={{ fontSize: 22, fontFamily: 'serif', margin: '0 0 8px' }}>Nothing is live right now.</h2>
            <p style={{ color: '#b8b8c0', fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>Admins can launch a new raffle or direct-buy drop from the portal and it will appear here automatically.</p>
            <Link href="/catalog" style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 999, background: '#ffffff', color: '#000000', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>View catalog</Link>
          </section>
        )}
      </div>
    </main>
  );
}
