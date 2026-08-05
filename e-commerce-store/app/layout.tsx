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
        {/* TOP BAR - ALWAYS VISIBLE ON EVERY PAGE */}
        <header
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '56px',
            borderBottom: '1px solid #222222',
            background: 'rgba(10,10,10,0.88)',
            backdropFilter: 'blur(15px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 16px',
            zIndex: 100,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', gap: 14, fontSize: 11, letterSpacing: 2, fontWeight: 600 }}>
            <Link href="/catalog" style={{ color: '#ccc', textDecoration: 'none' }}>CATALOG</Link>
            <Link href="/story" style={{ color: '#666', textDecoration: 'none' }}>STORY</Link>
          </div>

          <Link
            href="/"
            style={{
              position: 'absolute',
              left: '50%',
              transform: 'translateX(-50%)',
              fontWeight: 'bold',
              letterSpacing: '4px',
              fontSize: '12px',
              textTransform: 'uppercase',
              color: '#ffffff',
              textDecoration: 'none',
            }}
          >
            GOYUNIR
          </Link>
          
          <div style={{ display: 'flex', gap: 14, fontSize: 11, letterSpacing: 2, fontWeight: 600 }}>
            <Link href="/account" style={{ color: '#666', textDecoration: 'none' }}>ACCOUNT</Link>
          </div>
        </header>

        {/* PAGE CONTENT - with padding for top bar */}
        <div style={{ paddingTop: '56px', minHeight: '100vh' }}>
          {children}
        </div>

        {/* FOOTER - ALWAYS VISIBLE */}
        <footer style={{ 
          background: 'rgba(10,10,10,0.95)', 
          backdropFilter: 'blur(15px)',
          borderTop: '1px solid #222222',
          padding: '30px 20px 20px',
          textAlign: 'center',
          color: '#666',
          fontSize: 12,
          position: 'relative',
          zIndex: 10,
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