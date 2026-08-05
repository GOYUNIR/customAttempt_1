import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const redis = createRedisClient();
  let hasProducts = false;
  let redirectSlug = null;
  
  if (redis) {
    try {
      const activeRaw = await redis.hgetall('store:active_products');
      if (activeRaw && Object.keys(activeRaw).length > 0) {
        for (const [key, value] of Object.entries(activeRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            if (product.isActive && !product.isArchived && !product.isUpcoming && product.slug) {
              hasProducts = true;
              redirectSlug = product.slug;
              break;
            }
          } catch (e) {
            console.error('[HomePage] Error parsing product:', e);
          }
        }
      }
    } catch (error) {
      console.error('[HomePage] Redis error:', error);
    }
  }
  
  // If we found a product, redirect to it
  if (hasProducts && redirectSlug) {
    redirect(`/${redirectSlug}`);
  }
  
  // No products in Redis - show coming soon page with top bar
  return (
    <main style={{ 
      minHeight: '100vh', 
      background: '#0a0a0a', 
      color: '#ffffff',
      fontFamily: 'system-ui, sans-serif'
    }}>
      {/* TOP BAR - Same as Storefront header */}
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

      {/* MAIN CONTENT */}
      <div style={{ 
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '80px 20px 40px',
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
      </div>
    </main>
  );
}