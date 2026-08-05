import { Suspense } from 'react';
import Storefront from '@/components/Storefront';

export const dynamic = 'force-dynamic';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  
  // Always render Storefront - it will handle product loading and show "No products available" if needed
  return (
    <Suspense fallback={null}>
      <Storefront initialSlug={slug} />
    </Suspense>
  );
}