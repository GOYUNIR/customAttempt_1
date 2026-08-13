import Link from 'next/link';

export default function NotFoundView() {
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
    }}>
      <div style={{ textAlign: 'center', maxWidth: '480px' }}>
        <div style={{
          fontSize: '80px',
          marginBottom: '16px',
          color: '#333'
        }}>
          404
        </div>
        <h1 style={{
          fontSize: '28px',
          fontFamily: 'serif',
          margin: '0 0 12px',
          fontWeight: 'normal'
        }}>
          Page Not Found
        </h1>
        <p style={{ color: '#888', fontSize: '14px', lineHeight: '1.7', marginBottom: '32px' }}>
          This product isn&apos;t available right now. Check out our catalog for what&apos;s currently available.
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
