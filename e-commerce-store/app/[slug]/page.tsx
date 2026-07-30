import { notFound } from 'next/navigation';
import Storefront from '@/components/Storefront';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function ProductPage({ params }: { params: { slug: string } }) {
  const exists = GOYUNIR_STORE_SUITE.productCatalog.some((p) => p.slug === params.slug);
  if (!exists) notFound();
  return <Storefront initialSlug={params.slug} />;
}