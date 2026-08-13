import type { Metadata } from "next";
import "./globals.css";
import SiteChrome from '@/components/SiteChrome';
import { createRedisClient, loadStoreConfigCached } from '@/lib/server-config';

export async function generateMetadata(): Promise<Metadata> {
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const branding = config.branding || {};
  const brandName = String(branding.brandName || branding.shareTitle || 'GOYUNIR');
  const shareDescription = String(branding.shareDescription || 'Handcrafted fragrance allocations — private raffle drops, first-access alerts, and clean checkout for high-intent collectors.');
  const themeColor = String(branding.shareAccent || config.themeColors?.accentBlue || '#D4AF37');

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
    themeColor,
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Bake the live Redis theme (colors/font) into the server-rendered page shell
  // so design presets apply even before SiteChrome hydrates and updates the
  // body client-side. Falls back to the dark defaults when Redis is empty.
  const redis = createRedisClient();
  const config = await loadStoreConfigCached(redis);
  const colors = config.themeColors || {};
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
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}