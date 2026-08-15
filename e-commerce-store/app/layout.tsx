import type { Metadata, Viewport } from "next";
import "./globals.css";
import SiteChrome from '@/components/SiteChrome';
import ThemeProvider, { type LiveThemeValue } from '@/components/ThemeProvider';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { mergeOrbsConfig, isLegacyHeroContent } from '@/lib/storefront-config';
import { getSiteUrl, neutralBrandName } from '@/lib/env';
import { getRequestSiteUrl } from '@/lib/request-url';

// Render the page shell per-request so the live /admin → Settings theme
// (colors/font/branding) is baked into the server HTML. Without this, the
// static shell shows build-time colors and then flashes to the saved theme
// after SiteChrome hydrates and swaps it in client-side. Redis reads stay
// cheap via the 30s TTL cache (loadStoreConfigCached).
export const dynamic = 'force-dynamic';

/** Build the live theme blob shared by the layout inline script + ThemeProvider. */
async function buildLiveTheme(redis: ReturnType<typeof createRedisClient>) {
  const config = await loadStoreConfigCached(redis);
  const defaults = GOYUNIR_STORE_SUITE as any;
  const themeColors = { ...(defaults.themeColors || {}), ...(config.themeColors || {}) };
  // Legacy heroContent (written before the story fields existed) is stale text
  // that was never displayed — use the current defaults instead.
  const heroContent = isLegacyHeroContent(config.heroContent)
    ? { ...(defaults.heroContent || {}) }
    : { ...(defaults.heroContent || {}), ...(config.heroContent || {}) };
  const liveValue: LiveThemeValue = {
    themeColors,
    branding: config.branding || {},
    orbs: mergeOrbsConfig(config.orbs),
    heroContent,
    copy: config.copy || {},
    gallery: config.gallery || {},
    footer: config.brandFooterData || {},
    legal: config.legal || {},
  };
  return liveValue;
}

export async function generateMetadata(): Promise<Metadata> {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const branding = config.branding || {};
  const brandName = String(branding.brandName || branding.shareTitle || neutralBrandName());
  const shareDescription = String(branding.shareDescription || GOYUNIR_STORE_SUITE.heroContent?.body || 'Private releases, handled cleanly.');
  // The site URL is NEVER hardcoded — set NEXT_PUBLIC_URL / NEXT_PUBLIC_SITE_URL /
  // SITE_URL in the platform (Vercel) and it flows into metadata, canonical, OG
  // and emails. See lib/env.ts for the full alias chain. When the platform env
  // is unset we fall back to the CURRENT REQUEST's host (so a deployed store
  // always tags its real domain), then the admin Branding → Share URL, then a
  // neutral placeholder. Without the request-host fallback, link previews used
  // to resolve og:url / og:image against "https://example.com" and messengers
  // showed a stock, broken card.
  const envSiteUrl = getSiteUrl();
  const requestSiteUrl = await getRequestSiteUrl();
  const adminShareUrl = String(branding.shareUrl || '').trim().replace(/\/+$/, '');
  const base = envSiteUrl || requestSiteUrl || adminShareUrl || 'https://example.com';
  const canonicalUrl = adminShareUrl && /^https?:\/\//i.test(adminShareUrl) ? adminShareUrl : base;
  const ogImageUrl = `${base.replace(/\/+$/, '')}/opengraph-image`;

  return {
    metadataBase: new URL(base),
    title: {
      default: brandName,
      template: `%s | ${brandName}`,
    },
    description: shareDescription,
    alternates: {
      canonical: canonicalUrl,
    },
    icons: {
      icon: '/icon',
      apple: '/icon',
    },
    openGraph: {
      title: brandName,
      description: shareDescription,
      url: canonicalUrl,
      siteName: brandName,
      // Absolute URL — messengers (WhatsApp / iMessage / Discord / Slack) fetch
      // the image from the rendered card, so a relative path never works for them.
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: brandName }],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: brandName,
      description: shareDescription,
      images: [ogImageUrl],
    },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const branding = config.branding || {};
  return {
    themeColor: String(branding.shareAccent || config.themeColors?.accentBlue || '#D4AF37'),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Bake the live Redis theme (colors/font) into the server-rendered page shell
  // so design presets apply even before SiteChrome hydrates and updates the
  // body client-side. Falls back to the dark defaults when Redis is empty.
  const redis = createRedisClient();
  const liveValue = await buildLiveTheme(redis);
  const colors = liveValue.themeColors || {};
  // Keep the inline JSON safe for a <script> block (escape any "</" sequences).
  const safeJson = JSON.stringify(liveValue).replace(/</g, '\\u003c');
  // The CSS custom properties applied by the synchronous inline script below
  // (and consumed by the storefront CSS) are baked into the server HTML too, so
  // React hydration sees the same <html> style the inline script leaves behind.
  // suppressHydrationWarning is required because the inline script mutates the
  // live DOM BEFORE React hydrates — without it every page logs a React 418
  // "A tree hydrated but some attributes ... didn't match" error.
  const radiusRaw = Number(colors.borderRadius);
  const htmlStyle = {
    '--ui-radius': `${Number.isFinite(radiusRaw) && radiusRaw >= 0 ? radiusRaw : 12}px`,
    '--background': colors.primaryBackground || '#0a0a0a',
    '--foreground': colors.textMain || '#ffffff',
    '--ui-chrome-alpha': String(Math.max(40, Math.min(100, Number(colors.chromeTransparency) || 94))),
    '--ui-surface-alpha': String(Math.max(40, Math.min(100, Number(colors.surfaceTransparency) || 100))),
  } as React.CSSProperties;
  return (
    <html lang="en" suppressHydrationWarning style={htmlStyle}>
      <body
        suppressHydrationWarning
        style={{
          margin: 0,
          padding: 0,
          background: colors.primaryBackground || '#0a0a0a',
          color: colors.textMain || '#ffffff',
          fontFamily: colors.fontFamily || undefined,
        }}
      >
        {/* Inline theme blob: applies the live colors synchronously before paint
            (covers cached HTML) and exposes window.__GOYUNIR_THEME__ for any
            client module that needs the saved theme before hydration. */}
        <script id="goyunir-theme-json" type="application/json" dangerouslySetInnerHTML={{ __html: safeJson }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var el=document.getElementById('goyunir-theme-json');var t=el?JSON.parse(el.textContent):null;if(!t)return;var c=t.themeColors||{};var b=document.body.style;if(c.primaryBackground)b.background=c.primaryBackground;if(c.textMain)b.color=c.textMain;if(c.fontFamily)b.fontFamily=c.fontFamily;var r=document.documentElement.style;var rad=Number(c.borderRadius);r.setProperty('--ui-radius',(Number.isFinite(rad)&&rad>=0?rad:12)+'px');r.setProperty('--background',c.primaryBackground||'#0a0a0a');r.setProperty('--foreground',c.textMain||'#ffffff');r.setProperty('--ui-chrome-alpha',String(Math.max(40,Math.min(100,Number(c.chromeTransparency)||94))));r.setProperty('--ui-surface-alpha',String(Math.max(40,Math.min(100,Number(c.surfaceTransparency)||100))));window.__GOYUNIR_THEME__=t;}catch(e){}})();`,
          }}
        />
        <ThemeProvider value={liveValue}>
          <SiteChrome>{children}</SiteChrome>
        </ThemeProvider>
      </body>
    </html>
  );
}