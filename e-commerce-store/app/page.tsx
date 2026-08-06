import { redirect } from 'next/navigation';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  console.log('[HomePage] Starting...');
  
  const redis = createRedisClient();
  let redirectSlug = null;
  
  if (redis) {
    try {
      // First check active products
      const activeRaw = await redis.hgetall('store:active_products');
      console.log('[HomePage] Active products:', activeRaw);
      
      if (activeRaw && Object.keys(activeRaw).length > 0) {
        // Find the first active product
        for (const [key, value] of Object.entries(activeRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            console.log('[HomePage] Checking product:', product.name, 'slug:', product.slug, 'active:', product.isActive, 'archived:', product.isArchived);
            if (product.isActive && !product.isArchived && !product.isUpcoming && product.slug) {
              redirectSlug = product.slug;
              console.log('[HomePage] ✅ Found redirect slug:', redirectSlug);
              break;
            }
          } catch (e) {
            console.error('[HomePage] Error parsing product:', e);
          }
        }
      }
      
      // If nothing found, check all products as fallback
      if (!redirectSlug) {
        const allRaw = await redis.hgetall('store:products');
        console.log('[HomePage] All products fallback:', allRaw);
        if (allRaw) {
          for (const [key, value] of Object.entries(allRaw)) {
            try {
              const product = JSON.parse(typeof value === 'string' ? value : '{}');
              if (product.isActive && !product.isArchived && product.slug) {
                redirectSlug = product.slug;
                console.log('[HomePage] ✅ Found in fallback:', redirectSlug);
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
    console.log('[HomePage] ❌ Redis client is null');
  }
  
  // Force redirect if we found a slug
  if (redirectSlug) {
    console.log('[HomePage] 🚀 Redirecting to:', `/${redirectSlug}`);
    redirect(`/${redirectSlug}`);
  }
  
  // If we get here, no products were found
  console.log('[HomePage] ❌ No products found, showing Coming Soon');
  
  // Show a simple fallback - but this should only happen if Redis is empty
  return (
    <main style={{ 
      minHeight: '100vh', 
      background: '#0a0a0a', 
      color: '#ffffff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{ textAlign: 'center', maxWidth: '480px' }}>
        <div style={{ fontSize: '14px', letterSpacing: '6px', textTransform: 'uppercase', color: '#666', marginBottom: '16px' }}>
          GOYUNIR
        </div>
        <h1 style={{ fontSize: '32px', fontFamily: 'serif', margin: '0 0 12px', fontWeight: 'normal' }}>
          Coming Soon
        </h1>
        <p style={{ color: '#888', fontSize: '14px', lineHeight: '1.7', marginBottom: '32px' }}>
          Our allocation drops are being prepared. Check back soon.
        </p>
        <a 
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
        </a>
      </div>
    </main>
  );
}