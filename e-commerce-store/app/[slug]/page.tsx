import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import Storefront from '@/components/Storefront';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  
  console.log('[ProductPage] Checking slug:', slug);
  
  const redis = createRedisClient();
  let exists = false;
  let productName = '';
  
  if (redis) {
    try {
      // Check ALL products (not just active ones)
      const allRaw = await redis.hgetall('store:products');
      if (allRaw) {
        for (const [key, value] of Object.entries(allRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            if (product.slug === slug) {
              exists = true;
              productName = product.name || slug;
              console.log('[ProductPage] Found product:', productName);
              break;
            }
          } catch (e) {
            console.error('[ProductPage] Error parsing product:', e);
          }
        }
      }
      
      // If not found, check active products separately
      if (!exists) {
        const activeRaw = await redis.hgetall('store:active_products');
        if (activeRaw) {
          for (const [key, value] of Object.entries(activeRaw)) {
            try {
              const product = JSON.parse(typeof value === 'string' ? value : '{}');
              if (product.slug === slug) {
                exists = true;
                productName = product.name || slug;
                console.log('[ProductPage] Found active product:', productName);
                break;
              }
            } catch (e) {
              console.error('[ProductPage] Error parsing active product:', e);
            }
          }
        }
      }
      
      // If still not found, check archived products
      if (!exists) {
        const archivedRaw = await redis.hgetall('store:archived_products');
        if (archivedRaw) {
          for (const [key, value] of Object.entries(archivedRaw)) {
            try {
              const product = JSON.parse(typeof value === 'string' ? value : '{}');
              if (product.slug === slug) {
                exists = true;
                productName = product.name || slug;
                console.log('[ProductPage] Found archived product:', productName);
                break;
              }
            } catch (e) {
              console.error('[ProductPage] Error parsing archived product:', e);
            }
          }
        }
      }
    } catch (error) {
      console.error('[ProductPage] Redis error:', error);
    }
  }
  
  // If Redis is not available, check if it's one of the default products
  if (!exists && !redis) {
    const defaultSlugs = ['elysian-white', 'obsidian-void'];
    if (defaultSlugs.includes(slug)) {
      exists = true;
      console.log('[ProductPage] Using fallback for:', slug);
    }
  }
  
  console.log('[ProductPage] Slug:', slug, 'Exists:', exists);
  
  if (!exists) {
    console.log('[ProductPage] Product not found, returning 404');
    notFound();
  }

  return (
    <Suspense fallback={null}>
      <Storefront initialSlug={slug} />
    </Suspense>
  );
}