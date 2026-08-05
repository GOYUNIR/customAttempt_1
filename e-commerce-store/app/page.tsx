import { redirect } from 'next/navigation';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const redis = createRedisClient();
  let redirectSlug = null;
  
  if (redis) {
    try {
      const activeRaw = await redis.hgetall('store:active_products');
      if (activeRaw) {
        for (const [key, value] of Object.entries(activeRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            if (product.isActive && !product.isArchived && !product.isUpcoming && product.slug) {
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
  
  // If we found an active product, redirect to it
  if (redirectSlug) {
    redirect(`/${redirectSlug}`);
  }
  
  // No active products - show coming soon page (layout handles top bar)
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
      </div>
    </main>
  );
}