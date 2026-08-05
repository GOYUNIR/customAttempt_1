import { Suspense } from 'react';
import { redirect } from 'next/navigation';
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
  
  if (redis) {
    try {
      const allRaw = await redis.hgetall('store:products');
      if (allRaw) {
        for (const [key, value] of Object.entries(allRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            if (product.slug === slug) {
              exists = true;
              console.log('[ProductPage] Found product in Redis:', product.name);
              break;
            }
          } catch (e) {
            console.error('[ProductPage] Error parsing product:', e);
          }
        }
      }
    } catch (error) {
      console.error('[ProductPage] Redis error:', error);
    }
  }
  
  if (!exists) {
    console.log('[ProductPage] Product not found in Redis, redirecting to catalog');
    redirect('/catalog');
  }

  return (
    <Suspense fallback={null}>
      <Storefront initialSlug={slug} />
    </Suspense>
  );
}