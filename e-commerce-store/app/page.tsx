'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [hasProducts, setHasProducts] = useState(false);
  const configPalette = GOYUNIR_STORE_SUITE.themeColors;

  useEffect(() => {
    async function checkProducts() {
      try {
        const res = await fetch('/api/store/config');
        const data = await res.json();
        
        if (data.activeProducts && data.activeProducts.length > 0) {
          setHasProducts(true);
          // Redirect to first active product
          const firstProduct = data.activeProducts[0];
          if (firstProduct.slug) {
            router.push(`/${firstProduct.slug}`);
            return;
          }
        }
      } catch (err) {
        console.error('[HomePage] Error checking products:', err);
      }
      setLoading(false);
    }
    
    checkProducts();
  }, [router]);

  if (loading) {
    return (
      <main style={{ 
        minHeight: '100vh', 
        background: '#0a0a0a', 
        color: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        fontFamily: 'system-ui, sans-serif'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, letterSpacing: 4, textTransform: 'uppercase', color: '#666' }}>Loading</div>
          <div style={{ marginTop: 12, width: 40, height: 2, background: '#a855f7', margin: '12px auto' }} />
        </div>
      </main>
    );
  }

  return (
    <main style={{ 
      minHeight: '100vh', 
      background: '#0a0a0a', 
      color: '#ffffff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{ textAlign: 'center', maxWidth: '480px' }}>
        <div style={{ fontSize: '14px', letterSpacing: '6px', textTransform: 'uppercase', color: '#666', marginBottom: '16px' }}>
          GOYUNIR
        </div>
        <h1 style={{ fontSize: '32px', fontFamily: 'serif', margin: '0 0 12px', fontWeight: 'normal' }}>
          Coming Soon
        </h1>
        <p style={{ color: '#888', fontSize: '14px', lineHeight: '1.7', marginBottom: '32px' }}>
          Our allocation drops are being prepared. Check back soon.
        </p>
        <Link 
          href="/catalog" 
          style={{
            padding: '12px 28px',
            borderRadius: '30px',
            background: '#ffffff',
            color: '#000000',
            textDecoration: 'none',
            fontWeight: '600',
            fontSize: '14px',
            display: 'inline-block',
          }}
        >
          View Catalog
        </Link>
      </div>
    </main>
  );
}