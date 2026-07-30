import { redirect } from 'next/navigation';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';
import { getVisibleProducts } from '@/lib/storefront-config';

export default function HomePage() {
  const first = getVisibleProducts(GOYUNIR_STORE_SUITE)[0];
  if (first?.slug) redirect(`/${first.slug}`);
  return null;
}