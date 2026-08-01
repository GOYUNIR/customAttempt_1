export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 20px 80px', color: '#e5e5e5', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'system-ui,sans-serif', lineHeight: 1.6, fontSize: 14 }}>
      <a href="/" style={{ color: '#888', fontSize: 12 }}>← Store</a>
      <h1 style={{ fontSize: 28, margin: '24px 0 8px' }}>Privacy Policy</h1>
      <p style={{ color: '#888', fontSize: 12 }}>Last updated: {new Date().toISOString().slice(0, 10)}</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>What we collect</h2>
      <p>Email, shipping address, and payment details processed by Stripe. Device/session identifiers for fraud reduction and basic analytics. Entry and draw logs stored in our database (e.g. Redis).</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>How we use it</h2>
      <p>To run allocations, charge selected entrants, ship orders, prevent abuse, send transactional email, and improve the service.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Sharing</h2>
      <p>Stripe (payments), email delivery provider (e.g. Resend), hosting (e.g. Vercel), and shipping partners as needed to fulfill. We do not sell personal information.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Retention</h2>
      <p>Entry and order records are kept as long as needed for operations, legal, and accounting purposes.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>Your choices</h2>
      <p>Manage My Entry allows address/payment updates where available. Contact support to request access or deletion where applicable law requires.</p>
    </main>
  );
}