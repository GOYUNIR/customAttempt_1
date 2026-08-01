import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function StoryPage() {
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '48px 20px 80px', color: '#e5e5e5', background: '#0a0a0a', minHeight: '100vh', fontFamily: 'system-ui,sans-serif', lineHeight: 1.7, fontSize: 15 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 32, fontSize: 12, letterSpacing: 2 }}>
        <a href="/catalog" style={{ color: '#888', textDecoration: 'none' }}>CATALOG</a>
        <span style={{ color: '#fff' }}>STORY</span>
      </div>
      <h1 style={{ fontFamily: 'serif', fontSize: 32, margin: '0 0 16px' }}>Our scent identity</h1>
      <p style={{ color: '#aaa' }}>
        GOYUNIR engineering blends raw extraction mechanics with hyper-modern chemical balancing. Limited allocations keep every release intentional—not infinite shelf stock.
      </p>
      <p style={{ color: '#aaa' }}>
        Enter once per scent. Card is saved; you are charged only if selected. When a drop returns, existing entries stay in the pool so you don’t start over.
      </p>
      <a href="/" style={{ display: 'inline-block', marginTop: 32, color: '#fff', fontSize: 13 }}>
        ← Back to allocation
      </a>
      <p style={{ marginTop: 48, fontSize: 11, color: '#555' }}>
        {GOYUNIR_STORE_SUITE.brandFooterData.corporateEntityCopyright}
      </p>
    </main
  );
}// redeploy 20260801145801
//bro
