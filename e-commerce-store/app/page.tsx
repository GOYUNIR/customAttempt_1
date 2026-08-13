'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import ReleaseWaitlist from '@/components/ReleaseWaitlist';
import { fetchStoreJson } from '@/lib/client-store-cache';

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [activeProducts, setActiveProducts] = useState<any[]>([]);
  const [socialProofDisplay, setSocialProofDisplay] = useState<number>(0);
  const [nowTick, setNowTick] = useState(Date.now());
  // Live theme palette. Starts at the build-time config and upgrades to whatever
  // is saved in /admin → Settings (served through `/api/store` → config →
  // themeColors) so design presets (e.g. a white Luxury background) apply to the
  // static home shell without a redeploy.
  const [configPalette, setConfigPalette] = useState<any>(GOYUNIR_STORE_SUITE.themeColors);

  // Only tick the clock while at least one release shows a live countdown —
  // otherwise the whole page re-renders every second for nothing.
  const needsCountdown = activeProducts.some((product: any) => {
    const releaseEndsAt = product.releaseEndsAt ? new Date(product.releaseEndsAt).getTime() : NaN;
    return Number.isFinite(releaseEndsAt) && releaseEndsAt > Date.now();
  });

  useEffect(() => {
    if (!needsCountdown) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [needsCountdown]);

  useEffect(() => {
    async function checkProducts() {
      try {
        const data = await fetchStoreJson('/api/store');
        if (data?.config?.themeColors) setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
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

  if (loading) {
    return (
      <main style={{ minHeight: '100vh', background: configPalette.primaryBackground, color: configPalette.textMain, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: '4px', textTransform: 'uppercase', color: '#666' }}>Loading live drops</div>
          <div style={{ marginTop: 12, width: 44, height: 2, background: configPalette.accentPurple, marginLeft: 'auto', marginRight: 'auto' }} />
        </div>
      </main>
    );
  }

  const primaryProduct = activeProducts[0];
  const soldOutProducts = activeProducts.filter((product: any) => product.soldOut);

  const formatCountdown = (product: any) => {
    if (product.isArchived) return 'Archived release';
    const releaseEndsAt = product.releaseEndsAt ? new Date(product.releaseEndsAt).getTime() : NaN;
    if (product.soldOut) return 'Sold out';
    if (Number.isFinite(releaseEndsAt) && releaseEndsAt > nowTick) {
      const diff = Math.max(0, releaseEndsAt - nowTick);
      const total = Math.floor(diff / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      return `${days}d ${hours}h ${minutes}m ${seconds}s left`;
    }
    if (product.goLiveAt) {
      const goLiveAt = new Date(product.goLiveAt).getTime();
      if (Number.isFinite(goLiveAt) && goLiveAt > nowTick) return 'Opening soon';
    }
    return 'Until sold out';
  };

  return (
    <main style={{ minHeight: '100vh', background: configPalette.primaryBackground, color: configPalette.textMain, padding: '26px 16px 72px', fontFamily: 'system-ui, sans-serif' }}>
      <style>{`@keyframes goyunirFadeUp { 0% { opacity: 0; transform: translateY(16px); } 100% { opacity: 1; transform: translateY(0); } } @keyframes goyunirPulse { 0%, 100% { opacity: 0.65; transform: scale(1); } 50% { opacity: 1; transform: scale(1.18); } }`}</style>
      <div style={{ maxWidth: 520, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section style={{ border: `1px solid ${configPalette.cardBorder}`, borderRadius: 28, padding: '22px 18px', background: 'linear-gradient(180deg, rgba(14,14,16,0.96), rgba(8,8,10,0.96))', boxShadow: '0 24px 70px rgba(0,0,0,0.28)', animation: 'goyunirFadeUp 700ms cubic-bezier(.22,1,.36,1) both' }}>
          <div style={{ fontSize: 12, letterSpacing: '4px', textTransform: 'uppercase', color: configPalette.cardTextMuted, marginBottom: 8 }}>GOYUNIR / HIGH-CADENCE RELEASES</div>
          <h1 style={{ fontSize: 32, fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 10px', lineHeight: 1.02, color: configPalette.cardTextMain }}>Luxury releases with private-club energy, built for decisive collectors.</h1>
          <p style={{ color: configPalette.cardTextMuted, fontSize: 14, lineHeight: 1.7, margin: '0 0 16px' }}>
            Handmade, low-volume, and intentionally scarce. Each release is tuned for trust, speed, and the feeling that not everyone gets through.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {primaryProduct?.slug ? (
              <button onClick={() => document.getElementById('goyunir-priority-drops')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} style={{ padding: '10px 16px', borderRadius: 999, background: configPalette.cardTextMain, color: configPalette.cardBackground, border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                Browse drops
              </button>
            ) : (
              activeProducts.length > 0 && (
                <Link href="/catalog" style={{ padding: '10px 16px', borderRadius: 999, background: configPalette.cardTextMain, color: configPalette.cardBackground, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
                  Browse catalog
                </Link>
              )
            )}
            <Link href="/story" style={{ padding: '10px 16px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.22)', background: 'transparent', color: configPalette.cardTextMain, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
              Our Story
            </Link>
            <span style={{ fontSize: 11, color: configPalette.cardTextMuted }}>Low supply. Fast conversion. Quiet exclusivity.</span>
          </div>
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 14, border: `1px solid ${configPalette.cardBorder}`, background: 'rgba(255,255,255,0.02)', fontSize: 12, color: configPalette.cardTextMuted }}>
            Total raffle entries: <strong>{socialProofDisplay.toLocaleString()}</strong>
          </div>
        </section>

        {activeProducts.length > 0 && (
          <section id="goyunir-priority-drops" style={{ animation: 'goyunirFadeUp 760ms cubic-bezier(.22,1,.36,1) both' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>Priority drops</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>Sorted by admin order</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeProducts.map((product: any, index: number) => (
                <Link key={product.id} href={`/${product.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ borderRadius: 22, overflow: 'hidden', border: `1px solid ${configPalette.cardBorder}`, background: product.soldOut ? 'linear-gradient(135deg, rgba(17,17,17,0.96), rgba(28,28,28,0.96))' : '#121217', boxShadow: '0 16px 48px rgba(0,0,0,0.22)', transform: `translateY(${index === 0 ? 0 : 2}px)`, animation: 'goyunirFadeUp 700ms cubic-bezier(.22,1,.36,1) both' }}>
                    <div style={{ height: 190, background: product.images?.[0] ? `linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.4)), url(${product.images[0]}) center/cover` : '#1a1a1a' }} />
                    <div style={{ padding: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <div style={{ fontSize: 11, color: product.soldOut ? '#fbbf24' : configPalette.accentPurple, textTransform: 'uppercase', letterSpacing: '2px' }}>{product.soldOut ? 'Social proof' : (index === 0 ? 'Primary release' : 'Featured release')}</div>
                        <div style={{ fontSize: 11, color: product.soldOut ? '#fcd34d' : configPalette.accentBlue, fontWeight: 700 }}>{product.soldOut ? 'Sold out' : 'Open now'}</div>
                      </div>
                      <div style={{ fontSize: 19, fontFamily: 'Georgia, Times New Roman, serif', marginBottom: 4, color: configPalette.cardTextMain }}>{product.name}</div>
                      <div style={{ fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.5 }}>{product.tagline || product.desc}</div>
                      <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 999, background: product.isUpcoming ? 'rgba(59,130,246,0.16)' : 'rgba(255,255,255,0.06)', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11, color: product.isUpcoming ? '#dbeafe' : '#e7e7eb', fontWeight: 700, border: product.isUpcoming ? '1px solid rgba(59,130,246,0.24)' : '1px solid rgba(255,255,255,0.08)' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: product.isUpcoming ? '#60a5fa' : (product.soldOut ? '#fbbf24' : '#7dd3fc'), animation: 'goyunirPulse 1s ease-in-out infinite' }} />
                        {product.isUpcoming ? `Release opens: ${formatCountdown(product)}` : formatCountdown(product)}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {activeProducts.length === 0 && (
          <ReleaseWaitlist
            source="home"
            headline="Get notified the moment the next release goes live."
            body="Join the alert list and we will send the drop as soon as it opens."
          />
        )}

        {soldOutProducts.length > 0 && (
          <section style={{ animation: 'goyunirFadeUp 780ms cubic-bezier(.22,1,.36,1) both' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>Social proof</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>Sold out releases keep the story alive</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {soldOutProducts.map((product: any) => (
                <Link key={product.id} href={`/${product.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div style={{ padding: '12px 14px', borderRadius: 16, background: 'rgba(255,255,255,0.04)', border: `1px solid ${configPalette.cardBorder}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: configPalette.cardTextMain }}>{product.name}</div>
                      <div style={{ fontSize: 11, color: configPalette.cardTextMuted, marginTop: 2 }}>{product.tagline || product.desc}</div>
                    </div>
                    <div style={{ fontSize: 11, color: '#fbbf24' }}>Sold out</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section style={{ border: `1px solid ${configPalette.cardBorder}`, borderRadius: 24, padding: '16px 15px', background: '#0e0e10', color: configPalette.cardTextMain, animation: 'goyunirFadeUp 800ms cubic-bezier(.22,1,.36,1) both' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>Member perk</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>Get 10% off your first release and private updates.</div>
            </div>
            <Link href="/auth/signup" style={{ padding: '10px 14px', borderRadius: 999, background: '#f5f5f5', color: '#060606', textDecoration: 'none', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>Create account</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
