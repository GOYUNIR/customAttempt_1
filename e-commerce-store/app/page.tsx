import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  console.log('[HomePage] Rendering...');
  
  const redis = createRedisClient();
  let redirectSlug = null;
  
  if (redis) {
    try {
      // Check active products first
      const activeRaw = await redis.hgetall('store:active_products');
      console.log('[HomePage] Active products from Redis:', activeRaw);
      
      if (activeRaw && Object.keys(activeRaw).length > 0) {
        for (const [key, value] of Object.entries(activeRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            console.log('[HomePage] Found product:', product.name, 'slug:', product.slug);
            if (product.isActive && !product.isArchived && !product.isUpcoming && product.slug) {
              redirectSlug = product.slug;
              console.log('[HomePage] Selected redirect slug:', redirectSlug);
              break;
            }
          } catch (e) {
            console.error('[HomePage] Error parsing product:', e);
          }
        }
      }
      
      // If no active products, check all products
      if (!redirectSlug) {
        const allRaw = await redis.hgetall('store:products');
        console.log('[HomePage] All products from Redis:', allRaw);
        if (allRaw) {
          for (const [key, value] of Object.entries(allRaw)) {
            try {
              const product = JSON.parse(typeof value === 'string' ? value : '{}');
              if (product.isActive && !product.isArchived && product.slug) {
                redirectSlug = product.slug;
                console.log('[HomePage] Found active in all products:', redirectSlug);
                break;
              }
            } catch (e) {
              console.error('[HomePage] Error parsing product:', e);
            }
          }
        }
      }
    } catch (error) {
      console.error('[HomePage] Redis error:', error);
    }
  } else {
    console.log('[HomePage] Redis client not available');
  }
  
  // If we found a product, redirect to it
  if (redirectSlug) {
    console.log('[HomePage] Redirecting to:', `/${redirectSlug}`);
    redirect(`/${redirectSlug}`);
  }
  
  // No products - show coming soon page
  console.log('[HomePage] No products found, showing Coming Soon');
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