export default function ShippingPage() {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px 80px', color: '#e5e5e5', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'system-ui,sans-serif', lineHeight: 1.6, fontSize: 14 }}>
      <a href="/" style={{ color: '#888', fontSize: 12 }}>← Store</a>
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