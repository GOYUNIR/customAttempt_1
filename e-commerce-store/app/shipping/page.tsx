import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function ShippingPage() {
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;
  
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px 80px', color: '#e5e5e5', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'system-ui,sans-serif', lineHeight: 1.6, fontSize: 14 }}>
      <Link
        href="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 44,
          padding: '0 18px',
          borderRadius: 999,
          fontSize: 13,
          fontWeight: 600,
          color: configPalette.textMain,
          textDecoration: 'none',
          background: 'rgba(255,255,255,0.06)',
          border: `1px solid ${configPalette.cardBorder}`,
          marginBottom: 24,
        }}
      >
        ← Back to store
      </Link>
      <h1 style={{ fontSize: 28, margin: '24px 0 8px' }}>Shipping &amp; Sales Policy</h1>
      <p style={{ color: '#888', fontSize: 12 }}>Last updated: {new Date().toISOString().slice(0, 10)}</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Shipping</h2>
      <p>If you are selected and charged, we ship to the address on your entry. You are responsible for providing a deliverable address. Risk of loss passes on delivery to the carrier where permitted by law.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Timing</h2>
      <p>Dispatch timing depends on allocation and fulfillment queues. Tracking is provided when the label is created.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>All sales final</h2>
      <p>Fragrance and allocated products are <strong>final sale</strong>. No returns, refunds, or exchanges once charged, except where required by law. Do not open sealed product if local law requires an unopened return exception—contact support before opening.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Failed delivery</h2>
      <p>Refused packages or incorrect addresses may not be re-shipped free of charge.</p>
    </main>
  );
}