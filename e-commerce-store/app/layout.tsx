import type { Metadata } from "next";
import "./globals.css";
import SiteChrome from '@/components/SiteChrome';
import { createRedisClient, loadStoreConfig } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const redis = createRedisClient();
  const config = await loadStoreConfig(redis);
  const branding = config.branding || {};
  const shareDescription = String(branding.shareDescription || 'Luxury raffle drops and direct releases built for high-intent mobile traffic.');
  const themeColor = String(branding.shareAccent || config.themeColors?.accentBlue || '#3b82f6');

  return {
    metadataBase: new URL('https://goyunir.com'),
    title: {
      default: 'GOYUNIR',
      template: '%s | GOYUNIR',
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
      title: 'GOYUNIR',
      description: shareDescription,
      url: 'https://goyunir.com',
      siteName: 'GOYUNIR',
      images: ['/opengraph-image'],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: 'GOYUNIR',
      description: shareDescription,
      images: ['/opengraph-image'],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#0a0a0a', color: '#ffffff' }}>
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}