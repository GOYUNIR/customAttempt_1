import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Simple landing page - redirects are handled by the client via Storefront
  return (
    <main style={{ 
      minHeight: 'calc(100vh - 56px)', 
      background: '#0a0a0a', 
      color: '#ffffff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: 'system-ui, sans-serif',
      marginTop: 0,
    }}>
      <div style={{ textAlign: 'center', maxWidth: '480px' }}>
        <div style={{ 
          fontSize: '14px', 
          letterSpacing: '6px', 
          textTransform: 'uppercase', 
          color: '#666',
          marginBottom: '16px'
        }}>
          GOYUNIR
        </div>
        <h1 style={{ 
          fontSize: '32px', 
          fontFamily: 'serif', 
          margin: '0 0 12px',
          fontWeight: 'normal'
        }}>
          Coming Soon
        </h1>
        <p style={{ color: '#888', fontSize: '14px', lineHeight: '1.7', marginBottom: '32px' }}>
          Our allocation drops are being prepared. Check back soon.
        </p>
        <Link 
          href="/catalog" 
          style={{
            padding: '12px 28px',
            borderRadius: '30px',
            background: '#ffffff',
            color: '#000000',
            textDecoration: 'none',
            fontWeight: '600',
            fontSize: '14px',
            display: 'inline-block',
          }}
        >
          View Catalog
        </Link>
      </div>
    </main>
  );
}