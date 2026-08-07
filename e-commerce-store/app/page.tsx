'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import ReleaseWaitlist from '@/components/ReleaseWaitlist';

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [activeProducts, setActiveProducts] = useState<any[]>([]);
  const [socialProofDisplay, setSocialProofDisplay] = useState<number>(0);
  const [raffleEndsAt, setRaffleEndsAt] = useState<number | null>(null);
  const [raffleCountdown, setRaffleCountdown] = useState('');
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  useEffect(() => {
    async function checkProducts() {
      try {
        const res = await fetch('/api/store');
        const data = await res.json();
        const sorted = Array.isArray(data.activeProducts)
          ? [...data.activeProducts].sort((a: any, b: any) => (Number(a.sortOrder || 0) - Number(b.sortOrder || 0)) || String(a.name).localeCompare(String(b.name)))
          : [];
        setActiveProducts(sorted);
        const drawAnchor = data?.config?.dropSchedule?.targetEndDateTime;
        const anchorMs = drawAnchor ? new Date(drawAnchor).getTime() : NaN;
        setRaffleEndsAt(Number.isFinite(anchorMs) ? anchorMs : null);
      } catch (err) {
        console.error('[HomePage] Error checking products:', err);
      } finally {
        setLoading(false);
      }
    }

    checkProducts();

    const visitorId = typeof window !== 'undefined'
      ? (window.localStorage.getItem('goyunir-visitor-id') || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      : '';
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('goyunir-visitor-id', visitorId);
      fetch(`/api/analytics/heartbeat?visitorId=${encodeURIComponent(visitorId)}`)
        .then((res) => res.json())
        .then((data) => setSocialProofDisplay(Number(data?.socialProofDisplay || 0)))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!raffleEndsAt) {
      setRaffleCountdown('');
      return;
    }
    const update = () => {
      const diff = raffleEndsAt - Date.now();
      if (diff <= 0) {
        setRaffleCountdown('Raffle window closed');
        return;
      }
      const total = Math.floor(diff / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      setRaffleCountdown(`${days}d ${hours}h ${minutes}m ${seconds}s`);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [raffleEndsAt]);

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
  const hasRaffleProduct = activeProducts.some((product) => String(product.checkoutMode || '').toUpperCase() === 'RAFFLE');

  return (
    <main style={{ minHeight: '100vh', background: 'radial-gradient(circle at top, rgba(59,130,246,0.14), transparent 36%), radial-gradient(circle at 20% 20%, rgba(168,85,247,0.16), transparent 28%), #07070a', color: configPalette.textMain, padding: '26px 16px 72px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section style={{ border: `1px solid ${configPalette.cardBorder}`, borderRadius: 28, padding: '22px 18px', background: 'linear-gradient(180deg, rgba(14,14,16,0.96), rgba(8,8,10,0.96))', boxShadow: '0 24px 70px rgba(0,0,0,0.28)' }}>
          <div style={{ fontSize: 12, letterSpacing: '4px', textTransform: 'uppercase', color: configPalette.textMuted, marginBottom: 8 }}>GOYUNIR / HIGH-CADENCE RELEASES</div>
          <h1 style={{ fontSize: 32, fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 10px', lineHeight: 1.02 }}>Luxury drops engineered for fast taps, fast trust, and zero friction.</h1>
          <p style={{ color: '#c8c8cf', fontSize: 14, lineHeight: 1.7, margin: '0 0 16px' }}>
            Built for raffle launches, premium FCFS releases, and mobile-first social traffic that decides in seconds.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link href="/catalog" style={{ padding: '10px 16px', borderRadius: 999, background: configPalette.textMain, color: configPalette.primaryBackground, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>Browse catalog</Link>
            {primaryProduct?.slug ? <Link href={`/${primaryProduct.slug}`} style={{ padding: '10px 16px', borderRadius: 999, border: `1px solid ${configPalette.cardBorder}`, color: configPalette.textMain, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>Open live drop</Link> : null}
          </div>
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 14, border: `1px solid ${configPalette.cardBorder}`, background: 'rgba(255,255,255,0.02)', fontSize: 12, color: '#d4d4d8' }}>
            Live raffle entries signal: <strong>{socialProofDisplay.toLocaleString()}</strong>
          </div>
          {hasRaffleProduct && raffleCountdown && (
            <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 14, border: `1px solid ${configPalette.cardBorder}`, background: 'rgba(255,255,255,0.015)', fontSize: 12, color: '#d4d4d8' }}>
              Raffle countdown: <strong>{raffleCountdown}</strong>
            </div>
          )}
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
            <div style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue, marginBottom: 8 }}>Release feed</div>
            <h2 style={{ fontSize: 22, fontFamily: 'serif', margin: '0 0 8px' }}>The next drop is not live yet.</h2>
            <p style={{ color: '#b8b8c0', fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>This space fills automatically when a raffle or direct release is published from the admin portal.</p>
            <Link href="/catalog" style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 999, background: '#ffffff', color: '#000000', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>View catalog</Link>
          </section>
        )}

        {activeProducts.length === 0 && (
          <ReleaseWaitlist
            source="home"
            headline="Get notified the moment the next release goes live."
            body="Join the alert list and we will send the drop as soon as it opens."
          />
        )}
      </div>
    </main>
  );
}
