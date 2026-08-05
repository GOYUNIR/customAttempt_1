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
  
  const redis = createRedisClient();
  let exists = false;
  
  if (redis) {
    try {
      // Check all products in Redis
      const allRaw = await redis.hgetall('store:products');
      if (allRaw) {
        for (const [key, value] of Object.entries(allRaw)) {
          try {
            const product = JSON.parse(typeof value === 'string' ? value : '{}');
            if (product.slug === slug) {
              exists = true;
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
  
  // If product doesn't exist in Redis, return 404
  if (!exists) {
    notFound();
  }

  return (
    <Suspense fallback={null}>
      <Storefront initialSlug={slug} />
    </Suspense>
  );
}