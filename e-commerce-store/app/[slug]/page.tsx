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
  
  // Always allow the default product slugs to work
  const defaultSlugs = ['elysian-white', 'obsidian-void'];
  if (defaultSlugs.includes(slug)) {
    console.log('[ProductPage] Using fallback for default slug:', slug);
    return (
      <Suspense fallback={null}>
        <Storefront initialSlug={slug} />
      </Suspense>
    );
  }
  
  const redis = createRedisClient();
  let exists = false;
  let productName = '';
  
  if (redis) {
    try {
      // Check ALL products
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
    } catch (error) {
      console.error('[ProductPage] Redis error:', error);
    }
  }
  
  // If the slug is a default slug but we couldn't verify it in Redis, still show it
  if (defaultSlugs.includes(slug)) {
    exists = true;
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