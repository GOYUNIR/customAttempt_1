import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Elysian Void Storefront",
  description: "High performance perfume store",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        {/* STICKY TOP BRAND HEADER */}
        <header style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '60px', borderBottom: '1px solid #222', background: 'rgba(10,10,10,0.8)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', zIndex: 100, boxSizing: 'border-box', color: '#fff', fontFamily: 'sans-serif' }}>
          <div style={{ fontWeight: 'bold', letterSpacing: '2px', fontSize: '14px', textTransform: 'uppercase' }}>
            GOYUNIR
          </div>
          <div style={{ cursor: 'pointer', background: '#222', padding: '6px 12px', borderRadius: '15px', fontSize: '12px' }}>
            Bag (0)
          </div>
        </header>

        {children}
      </body>
    </html>
  );
}
