import { redirect } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';
import { createRedisClient, getCatalogArchiveRecords } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const redis = createRedisClient();
  let archivedIds: string[] = [];
  if (redis) {
    try {
      const records = await getCatalogArchiveRecords(redis);
      archivedIds = records.map((r) => r.productId);
    } catch {}
  }

  const visible = getVisibleProducts(GOYUNIR_STORE_SUITE).filter((p) => !archivedIds.includes(p.id));

  // HOME_REDIRECT_SLUG: set `homeRedirectSlug` in goyunir.config.ts to pin
  // the homepage to one specific product (e.g. your flagship scent).
  // Leave it unset to always show whichever active product comes first.
  const preferredSlug = GOYUNIR_STORE_SUITE.homeRedirectSlug;
  const preferred = preferredSlug ? visible.find((p) => p.slug === preferredSlug) : undefined;
  const target = preferred ?? visible[0];

  if (target?.slug) {
    redirect(`/${target.slug}`);
  }

  // Nothing active/available — send visitors to the catalog instead.
  redirect('/catalog');
}