import { Suspense } from 'react';
import Storefront from '@/components/Storefront';

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <Storefront />
    </Suspense>
  );
}