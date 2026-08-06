import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function StoryPage() {
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  return (
    <main style={{ 
      maxWidth: 560, 
      margin: '0 auto', 
      padding: '80px 20px 60px', 
      color: '#e5e5e5', 
      background: '#0a0a0a', 
      minHeight: 'calc(100vh - 56px)', 
      fontFamily: 'system-ui,sans-serif', 
      lineHeight: 1.7, 
      fontSize: 15 
    }}>
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
      <div style={{ display: 'flex', gap: 16, marginBottom: 32, fontSize: 12, letterSpacing: 2 }}>
        <Link href="/catalog" style={{ color: '#888', textDecoration: 'none' }}>CATALOG</Link>
        <span style={{ color: '#fff' }}>STORY</span>
      </div>
      <h1 style={{ fontFamily: 'serif', fontSize: 32, margin: '0 0 16px' }}>Our scent identity</h1>
      <p style={{ color: '#aaa' }}>
        GOYUNIR engineering blends raw extraction mechanics with hyper-modern chemical balancing. Limited allocations keep every release intentional—not infinite shelf stock.
      </p>
      <p style={{ color: '#aaa' }}>
        Enter once per scent. Card is saved; you are charged only if selected. When a drop returns, existing entries stay in the pool so you don't start over.
      </p>
      <p style={{ marginTop: 48, fontSize: 11, color: '#555' }}>
        {GOYUNIR_STORE_SUITE.brandFooterData.corporateEntityCopyright}
      </p>
    </main>
  );
}