import { redirect } from 'next/navigation';
import { createRedisClient } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
  }
  const qs = params.toString();
  const suffix = qs ? `?${qs}` : '';

  const redis = createRedisClient();
  
  let homeRedirectSlug: string | undefined;
  let activeProducts: any[] = [];

  if (redis) {
    try {
      // Get config
      const configRaw = await redis.get('store:config');
      const config = JSON.parse(typeof configRaw === 'string' ? configRaw : '{}');
      homeRedirectSlug = config.homeRedirectSlug;
      
      // Get active products
      const activeRaw = await redis.hgetall('store:active_products');
      if (activeRaw) {
        activeProducts = Object.values(activeRaw)
          .map((v) => JSON.parse(typeof v === 'string' ? v : '{}'))
          .filter((p) => p.isActive && !p.isArchived);
      }
    } catch {}
  }

  // Fallback to first active product
  const targetSlug = homeRedirectSlug || activeProducts[0]?.slug;
  
  if (targetSlug) redirect(`/${targetSlug}${suffix}`);
  redirect(`/catalog${suffix}`);
}