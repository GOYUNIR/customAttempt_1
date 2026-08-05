import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import Storefront from '@/components/Storefront';
import { createRedisClient } from '@/lib/server-config';

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
      const activeRaw = await redis.hgetall('store:active_products');
      if (activeRaw) {
        const products = Object.values(activeRaw)
          .map((v) => JSON.parse(typeof v === 'string' ? v : '{}'));
        exists = products.some((p: any) => p.slug === slug && p.isActive && !p.isArchived);
      }
    } catch {}
  }
  
  if (!exists) {
    // Check if it's archived
    if (redis) {
      try {
        const archivedRaw = await redis.hgetall('store:archived_products');
        if (archivedRaw) {
          const products = Object.values(archivedRaw)
            .map((v) => JSON.parse(typeof v === 'string' ? v : '{}'));
          exists = products.some((p: any) => p.slug === slug);
        }
      } catch {}
    }
  }
  
  if (!exists) notFound();

  return (
    <Suspense fallback={null}>
      <Storefront initialSlug={slug} />
    </Suspense>
  );
}