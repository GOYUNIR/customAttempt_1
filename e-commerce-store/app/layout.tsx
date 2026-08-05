import type { Metadata } from "next";
import "./globals.css";
import Link from 'next/link';

export const metadata: Metadata = {
  title: "GOYUNIR Storefront",
  description: "High performance perfume store",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#0a0a0a', color: '#ffffff' }}>
        {children}
        <footer style={{ 
          background: 'rgba(10,10,10,0.95)', 
          backdropFilter: 'blur(15px)',
          borderTop: '1px solid #222222',
          padding: '30px 20px 20px',
          textAlign: 'center',
          color: '#666',
          fontSize: 12
        }}>
          <div style={{ maxWidth: 480, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>
              <Link href="/terms" style={{ color: '#666', textDecoration: 'none' }}>Terms</Link>
              <Link href="/privacy" style={{ color: '#666', textDecoration: 'none' }}>Privacy</Link>
              <Link href="/shipping" style={{ color: '#666', textDecoration: 'none' }}>Shipping</Link>
              <Link href="/account" style={{ color: '#666', textDecoration: 'none' }}>Manage My Entry</Link>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 16 }}>
              <a href="https://instagram.com/goyunir" target="_blank" rel="noreferrer" style={{ color: '#555', textDecoration: 'none' }}>Instagram</a>
              <a href="https://tiktok.com/goyunir" target="_blank" rel="noreferrer" style={{ color: '#555', textDecoration: 'none' }}>TikTok</a>
              <a href="mailto:goyunir.support@gmail.com" style={{ color: '#555', textDecoration: 'none' }}>goyunir.support@gmail.com</a>
            </div>
            <div style={{ color: '#333', fontSize: 10 }}>
              © {new Date().getFullYear()} GOYUNIR ALL RIGHTS RESERVED.
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}