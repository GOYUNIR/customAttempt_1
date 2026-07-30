import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import Storefront from '@/components/Storefront';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const exists = GOYUNIR_STORE_SUITE.productCatalog.some((p) => p.slug === slug);
  if (!exists) notFound();

  return (
    <Suspense fallback={null}>
      <Storefront initialSlug={slug} />
    </Suspense>
  );
}