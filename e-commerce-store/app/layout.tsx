import type { Metadata, Viewport } from "next";
import "./globals.css";
import SiteChrome from '@/components/SiteChrome';
import ThemeProvider, { type LiveThemeValue } from '@/components/ThemeProvider';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { mergeOrbsConfig, isLegacyHeroContent } from '@/lib/storefront-config';

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
  };
  return liveValue;
}

export async function generateMetadata(): Promise<Metadata> {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const branding = config.branding || {};
  const brandName = String(branding.brandName || branding.shareTitle || 'GOYUNIR');
  const shareDescription = String(branding.shareDescription || 'Handcrafted fragrance allocations — private raffle drops, first-access alerts, and clean checkout for high-intent collectors.');

  return {
    metadataBase: new URL('https://goyunir.com'),
    title: {
      default: brandName,
      template: `%s | ${brandName}`,
    },
    description: shareDescription,
    alternates: {
      canonical: 'https://goyunir.com',
    },
    icons: {
      icon: '/icon',
      apple: '/icon',
    },
    openGraph: {
      title: brandName,
      description: shareDescription,
      url: 'https://goyunir.com',
      siteName: brandName,
      images: ['/opengraph-image'],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: brandName,
      description: shareDescription,
      images: ['/opengraph-image'],
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
  return (
    <html lang="en">
      <body
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