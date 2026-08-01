import { redirect } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';
import { createRedisClient, getCatalogArchiveRecords } from '@/lib/server-config';

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
  let archivedIds: string[] = [];
  if (redis) {
    try {
      const records = await getCatalogArchiveRecords(redis);
      archivedIds = records.map((r) => r.productId);
    } catch {}
  }

  const visible = getVisibleProducts(GOYUNIR_STORE_SUITE).filter((p) => !archivedIds.includes(p.id));
  const preferredSlug = GOYUNIR_STORE_SUITE.homeRedirectSlug;
  const preferred = preferredSlug ? visible.find((p) => p.slug === preferredSlug) : undefined;
  const target = preferred ?? visible[0];

  if (target?.slug) redirect(`/${target.slug}${suffix}`);
  redirect(`/catalog${suffix}`);
}