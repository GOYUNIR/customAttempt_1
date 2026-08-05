import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function TermsPage() {
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
      <h1 style={{ fontSize: 28, margin: '24px 0 8px' }}>Terms of Service</h1>
      <p style={{ color: '#888', fontSize: 12 }}>Last updated: {new Date().toISOString().slice(0, 10)}</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>1. Allocation system</h2>
      <p>GOYUNIR operates limited product allocations. Entry does not guarantee receipt of product. Selection is at our discretion under published draw rules. One entry per email per product allocation unless we state otherwise.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>2. Payment</h2>
      <p>By completing entry you authorize GOYUNIR (via Stripe) to save your payment method. You are charged only if selected for that allocation. Failed charges may result in forfeiture of that selection.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>3. Eligibility</h2>
      <p>You must be able to form a binding contract in your jurisdiction and provide accurate shipping information. We may refuse or cancel entries that appear fraudulent or abusive.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>4. All sales final</h2>
      <p>Allocated products are final sale. No returns, refunds, or exchanges, except where required by law.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>5. Communications</h2>
      <p>We may email you about entry status, allocation results, shipping, and operational notices. Transactional messages are required to run the service.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>6. Limitation of liability</h2>
      <p>To the fullest extent permitted by law, GOYUNIR is not liable for indirect or consequential damages arising from use of the site or allocation process. Total liability for any claim is limited to the amount you paid for the specific allocation at issue.</p>

      <h2 style={{ fontSize: 16, marginTop: 28 }}>7. Contact</h2>
      <p>Support: use the address listed on the storefront or Manage My Entry.</p>
    </main>
  );
}