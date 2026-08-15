'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import ReleaseWaitlist from '@/components/ReleaseWaitlist';
import { fetchStoreJson } from '@/lib/client-store-cache';
import { notifyDropDue } from '@/lib/client-auto-draw';
import { useLiveTheme } from '@/components/ThemeProvider';
import { surfaceBackground, themeRadius, cardShadowStyle, contentSpacingScale, cardSheen } from '@/lib/storefront-config';
import { dropTimestampToMsOrNaN } from '@/lib/drop-timestamps';
import { neutralBrandName } from '@/lib/env';

/**
 * Home-page surfaces use the SAME surfaceBackground() helper as the catalog and
 * product pages. The background orbs live on the fixed zIndex-0 layer, which
 * paints above plain flow content — so as long as the sections here never
 * create their own stacking contexts, the glow shows over them exactly like it
 * does on every other page. The keyframes below end at `transform: none` and
 * every entrance uses `backwards` fill so a lingering transform (which would
 * trap the orbs behind the section surfaces) is impossible.
 */

export default function HomePage() {
  const liveCtx = useLiveTheme();
  const [loading, setLoading] = useState(true);
  const [activeProducts, setActiveProducts] = useState<any[]>([]);
  const [socialProofDisplay, setSocialProofDisplay] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(() => (typeof window !== 'undefined' ? Date.now() : 0));
  // Store drop timezone — naive product timestamps are interpreted in this zone
  // (never the viewer's local zone) so countdowns + draw triggers agree with the
  // server. Updated from /api/store config; defaults to the static config.
  const [storeTimezone, setStoreTimezone] = useState<string>(
    String(liveCtx?.dropSchedule?.timezone || GOYUNIR_STORE_SUITE.dropSchedule?.timezone || 'America/Los_Angeles'),
  );
  const [authUser, setAuthUser] = useState<any>(null);
  const [branding, setBranding] = useState<any>(liveCtx?.branding || null);
  // Live theme palette. Initialized from the server-baked /admin → Settings
  // theme (no flash), then upgraded by /api/store on mount so edits pick up
  // within the ~10s cache window without a redeploy.
  const [configPalette, setConfigPalette] = useState<any>(
    liveCtx?.themeColors ? { ...GOYUNIR_STORE_SUITE.themeColors, ...liveCtx.themeColors } : GOYUNIR_STORE_SUITE.themeColors,
  );
  // Hero copy is fully editable from /admin → Settings → Hero Content.
  const [heroContent, setHeroContent] = useState<any>(liveCtx?.heroContent || GOYUNIR_STORE_SUITE.heroContent);
  // Storefront copy overrides — editable from /admin → Settings → Storefront copy.
  // A non-empty value overrides the built-in default below (hero title/subtitle and
  // the "Priority drops" section header/subtitle).
  const [copyOverrides, setCopyOverrides] = useState<Record<string, any>>(liveCtx?.copy || {});

  const brandName = String(branding?.brandName || branding?.shareTitle || neutralBrandName());

  // Perf: skip rendering + painting of below-the-fold sections until they're
  // near the viewport (content-visibility: auto), and reserve their layout
  // height (containIntrinsicSize) so scroll position can never jump. Cast as
  // any because React's CSSProperties doesn't type these CSS properties yet.
  const SECTION_CV = { contentVisibility: 'auto', containIntrinsicSize: 'auto 320px' } as any;

  // Only tick the clock while at least one release shows a live countdown —
  // otherwise the whole page re-renders every second for nothing. Uses the
  // effective anchor (nextReleaseEndsAt for recurring raffles) so a mid-cycle
  // product showing the NEW timer keeps ticking.
  const needsCountdown = activeProducts.some((product: any) => {
    const anchor = String(product.nextReleaseEndsAt || product.releaseEndsAt || '');
    const anchorMs = anchor ? dropTimestampToMsOrNaN(anchor, storeTimezone) : NaN;
    return Number.isFinite(anchorMs) && anchorMs > nowTick;
  });

  useEffect(() => {
    if (!needsCountdown) return;
    const tick = () => setNowTick(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [needsCountdown]);

  // When a live product's raffle/entry timer hits zero on the home page, ping
  // the server to run the drop immediately (idempotent server-side). Runs on
  // mount too: a product whose releaseEndsAt already passed (store timezone)
  // while the visitor wasn't watching still triggers the draw on load.
  const dropNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!nowTick) return;
    for (const product of activeProducts) {
      const id = String(product?.id || '');
      if (!id || dropNotifiedRef.current.has(id)) continue;
      const endMs = product.releaseEndsAt ? dropTimestampToMsOrNaN(product.releaseEndsAt, storeTimezone) : NaN;
      if (Number.isFinite(endMs) && endMs <= nowTick) {
        dropNotifiedRef.current.add(id);
        notifyDropDue({ productId: id, productName: String(product?.name || ''), slug: String(product?.slug || '') });
      }
    }
  }, [nowTick, activeProducts, storeTimezone]);

  useEffect(() => {
    async function checkProducts() {
      try {
        const data = await fetchStoreJson('/api/store');
        if (data?.config?.themeColors) setConfigPalette({ ...GOYUNIR_STORE_SUITE.themeColors, ...data.config.themeColors });
        if (data?.config?.dropSchedule?.timezone) setStoreTimezone(String(data.config.dropSchedule.timezone));
        if (data?.config?.branding) setBranding(data.config.branding);
        if (data?.config?.heroContent) setHeroContent({ ...GOYUNIR_STORE_SUITE.heroContent, ...data.config.heroContent });
        if (data?.config?.copy) setCopyOverrides((prev) => ({ ...prev, ...data.config.copy }));
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

    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => setAuthUser(data?.user || null))
      .catch(() => setAuthUser(null));

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
          <div style={{ fontSize: 13, letterSpacing: '4px', textTransform: 'uppercase', color: configPalette.textMuted }}>Loading live drops</div>
          <div style={{ marginTop: 12, width: 44, height: 2, background: configPalette.accentPurple, marginLeft: 'auto', marginRight: 'auto' }} />
        </div>
      </main>
    );
  }

  const primaryProduct = activeProducts[0];
  const soldOutProducts = activeProducts.filter((product: any) => product.soldOut);

  const formatCountdown = (product: any) => {
    if (product.isArchived) return 'Archived release';
    if (product.soldOut) return 'Sold out';
    // Effective anchor: for a recurring raffle whose previous timer ended with
    // inventory remaining, `/api/store` provides `nextReleaseEndsAt` (the next
    // scheduled draw) — show THAT timer instead of "Until sold out".
    const anchorRaw = String(product.nextReleaseEndsAt || product.releaseEndsAt || '');
    const anchorMs = anchorRaw ? dropTimestampToMsOrNaN(anchorRaw, storeTimezone) : NaN;
    if (Number.isFinite(anchorMs) && anchorMs > nowTick) {
      const diff = Math.max(0, anchorMs - nowTick);
      const total = Math.floor(diff / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      return `${days}d ${hours}h ${minutes}m ${seconds}s left`;
    }
    if (product.goLiveAt) {
      const goLiveAt = dropTimestampToMsOrNaN(product.goLiveAt, storeTimezone);
      if (Number.isFinite(goLiveAt) && goLiveAt > nowTick) return 'Opening soon';
    }
    return 'Until sold out';
  };

  // Admin-editable storefront copy (settings.copy). Non-empty overrides win,
  // otherwise the built-in defaults are used. The priority-drops subtitle now
  // defaults to "Explore our creations" instead of the old "Curated by our team".
  const priorityDropsTitle = String(copyOverrides.priorityDropsTitle || 'Priority drops');
  const priorityDropsSubtitle = String(copyOverrides.priorityDropsSubtitle || 'Explore our creations');
  const heroTitle = String(copyOverrides.heroTitle || heroContent.headline || 'by our hands. to your hands.');
  const heroSubtitle = String(copyOverrides.heroSubtitle || heroContent.body || 'homemade & designed, with real ingredients, with real hands. for real people.');
  // Apple "less is more" rhythm: the admin contentSpacing setting scales the
  // page padding and section gaps so a buyer can dial the whitespace up/down.
  const spacing = contentSpacingScale(configPalette);

  return (
    <main style={{ minHeight: '100vh', background: configPalette.primaryBackground, color: configPalette.textMain, padding: `${Math.round(30 * spacing)}px 20px ${Math.round(80 * spacing)}px`, fontFamily: 'system-ui, sans-serif' }}>
      <style>{`@keyframes goyunirFadeUp { 0% { opacity: 0; transform: translateY(16px); } 100% { opacity: 1; transform: none; } } @keyframes goyunirPulse { 0%, 100% { opacity: 0.65; transform: scale(1); } 50% { opacity: 1; transform: scale(1.18); } }`}</style>
      <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: Math.round(20 * spacing) }}>
        <section style={{ border: `1px solid ${configPalette.cardBorder}`, borderRadius: themeRadius(configPalette, 26), padding: `${Math.round(28 * spacing)}px 22px`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, '#ffffff'), backgroundImage: cardSheen, boxShadow: cardShadowStyle(configPalette, 18), animation: 'goyunirFadeUp 700ms cubic-bezier(.22,1,.36,1) backwards' }}>
          <div style={{ fontSize: 12, letterSpacing: '4px', textTransform: 'uppercase', color: configPalette.cardTextMuted, marginBottom: 8, whiteSpace: 'pre-line' }}>{brandName.toUpperCase()} / {heroContent.eyebrow || 'CALIFORNIA USA'}</div>
          <h1 style={{ fontSize: 32, fontFamily: 'Georgia, Times New Roman, serif', margin: '0 0 10px', lineHeight: 1.02, color: configPalette.cardTextMain, whiteSpace: 'pre-line' }}>{heroTitle}</h1>
          <p style={{ color: configPalette.cardTextMuted, fontSize: 14, lineHeight: 1.7, margin: '0 0 16px', whiteSpace: 'pre-line' }}>
            {heroSubtitle}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {primaryProduct?.slug ? (
              <button onClick={() => document.getElementById('goyunir-priority-drops')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} style={{ padding: '10px 16px', borderRadius: 999, background: configPalette.cardTextMain, color: configPalette.cardBackground, border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {heroContent.ctaLabel || 'Browse drops'}
              </button>
            ) : (
              activeProducts.length > 0 && (
                <Link href="/catalog" prefetch={false} style={{ padding: '10px 16px', borderRadius: 999, background: configPalette.cardTextMain, color: configPalette.cardBackground, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
                  Browse catalog
                </Link>
              )
            )}
            <Link href="/story" prefetch={false} style={{ padding: '10px 16px', borderRadius: 999, border: `1px solid color-mix(in srgb, ${configPalette.cardTextMain} 32%, transparent)`, background: 'transparent', color: configPalette.cardTextMain, textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
              {heroContent.storyHeadline || 'Our Story'}
            </Link>
            <span style={{ fontSize: 11, color: configPalette.cardTextMuted }}>{heroContent.storyBody || 'Low supply. Fast conversion. Quiet exclusivity.'}</span>
          </div>
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 999, border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, 'rgba(255,255,255,0.06)'), fontSize: 12, color: configPalette.cardTextMuted }}>
            Total raffle entries: <strong>{socialProofDisplay.toLocaleString()}</strong>
          </div>
        </section>

        {activeProducts.length > 0 && (
          <section id="goyunir-priority-drops" style={{ ...SECTION_CV, animation: 'goyunirFadeUp 760ms cubic-bezier(.22,1,.36,1) backwards' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>{priorityDropsTitle}</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted, whiteSpace: 'pre-line' }}>{priorityDropsSubtitle}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(14 * spacing) }}>
              {activeProducts.map((product: any, index: number) => (
                <Link key={product.id} href={`/${product.slug}`} prefetch={false} style={{ textDecoration: 'none', color: 'inherit', display: 'block', borderRadius: themeRadius(configPalette, 22) }}>
                  <div style={{ borderRadius: themeRadius(configPalette, 22), overflow: 'hidden', border: `1px solid ${configPalette.cardBorder}`, background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, '#ffffff'), backgroundImage: cardSheen, boxShadow: cardShadowStyle(configPalette, 14), marginTop: index === 0 ? 0 : 2, animation: 'goyunirFadeUp 700ms cubic-bezier(.22,1,.36,1) backwards' }}>
                    <div style={{ height: 190, background: product.images?.[0] ? `linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.4)), url(${product.images[0]}) center/cover` : '#1a1a1a' }} />
                    <div style={{ padding: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <div style={{ fontSize: 11, color: configPalette.accentPurple, textTransform: 'uppercase', letterSpacing: '2px' }}>Featured release</div>
                        <div style={{ fontSize: 11, color: product.soldOut ? '#fcd34d' : configPalette.accentBlue, fontWeight: 700 }}>{product.soldOut ? 'Sold out' : 'Open now'}</div>
                      </div>
                      <div style={{ fontSize: 19, fontFamily: 'Georgia, Times New Roman, serif', marginBottom: 4, color: configPalette.cardTextMain }}>{product.name}</div>
                      <div style={{ fontSize: 12, color: configPalette.cardTextMuted, lineHeight: 1.5 }}>{product.tagline || product.desc}</div>
                      <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 999, background: product.isUpcoming ? `color-mix(in srgb, ${configPalette.accentBlue} 16%, transparent)` : `color-mix(in srgb, ${configPalette.cardTextMain} 10%, transparent)`, display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11, color: product.isUpcoming ? configPalette.accentBlue : configPalette.cardTextMain, fontWeight: 700, border: product.isUpcoming ? `1px solid color-mix(in srgb, ${configPalette.accentBlue} 30%, transparent)` : `1px solid color-mix(in srgb, ${configPalette.cardTextMain} 22%, transparent)` }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: product.isUpcoming ? configPalette.accentBlue : (product.soldOut ? '#fbbf24' : configPalette.accentBlue), boxShadow: '0 0 0 3px rgba(255,255,255,0.08)', animation: 'goyunirPulse 1s ease-in-out infinite' }} />
                        {product.isUpcoming ? `Release opens: ${formatCountdown(product)}` : formatCountdown(product)}
                      </div>
                      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: configPalette.accentBlue }}>
                          {product.soldOut ? 'Sold out' : product.isUpcoming ? 'Reserve your place' : 'Enter allocation'}
                        </span>
                        <span style={{ fontSize: 13, color: configPalette.accentBlue }}>→</span>
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
            palette={configPalette}
          />
        )}

        {soldOutProducts.length > 0 && (
          <section style={{ ...SECTION_CV, animation: 'goyunirFadeUp 780ms cubic-bezier(.22,1,.36,1) backwards' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 12, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>Featured releases</div>
              <div style={{ fontSize: 11, color: configPalette.textMuted }}>Sold out releases keep the story alive</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: Math.round(10 * spacing) }}>
              {soldOutProducts.map((product: any) => (
                <Link key={product.id} href={`/${product.slug}`} prefetch={false} style={{ textDecoration: 'none', color: 'inherit', display: 'block', borderRadius: themeRadius(configPalette, 18) }}>
                  <div style={{ padding: '14px 16px', borderRadius: themeRadius(configPalette, 18), background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, '#ffffff'), backgroundImage: cardSheen, border: `1px solid ${configPalette.cardBorder}`, boxShadow: cardShadowStyle(configPalette, 10), display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
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

        <section style={{ ...SECTION_CV, border: `1px solid ${configPalette.cardBorder}`, borderRadius: themeRadius(configPalette, 24), padding: '16px 15px', background: surfaceBackground(configPalette.cardBackground, configPalette.surfaceTransparency, '#0e0e10'), backgroundImage: cardSheen, color: configPalette.cardTextMain, animation: 'goyunirFadeUp 800ms cubic-bezier(.22,1,.36,1) backwards' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, letterSpacing: '3px', textTransform: 'uppercase', color: configPalette.accentBlue }}>
                {authUser ? 'Member account' : 'Member perk'}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
                {authUser
                  ? `You have ${Number(authUser.rewards || 0).toLocaleString()} points — redeem them for store credit in your account${authUser.welcomePromoCode ? '. Your 10% welcome credit is ready at checkout' : ''}.`
                  : 'Get 10% off your first release and private updates.'}
              </div>
            </div>
            {authUser ? (
              <Link href="/account" prefetch={false} style={{ padding: '10px 14px', borderRadius: 999, background: configPalette.accentBlue, color: '#04101f', textDecoration: 'none', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>My account</Link>
            ) : (
              <Link href="/auth/signup" prefetch={false} style={{ padding: '10px 14px', borderRadius: 999, background: '#f5f5f5', color: '#060606', textDecoration: 'none', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>Create account</Link>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
