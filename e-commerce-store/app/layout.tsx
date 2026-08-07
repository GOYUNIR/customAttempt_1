import type { Metadata } from "next";
import "./globals.css";
import SiteChrome from '@/components/SiteChrome';

export const metadata: Metadata = {
  metadataBase: new URL('https://goyunir.com'),
  title: "GOYUNIR",
  description: "Luxury raffle drops and direct releases built for high-intent mobile traffic.",
  openGraph: {
    title: 'GOYUNIR',
    description: 'Luxury raffle drops and direct releases built for high-intent mobile traffic.',
    url: 'https://goyunir.com',
    siteName: 'GOYUNIR',
  },
};

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