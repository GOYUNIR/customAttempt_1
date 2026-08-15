'use client';

import Link from 'next/link';
import { useLiveTheme } from '@/components/ThemeProvider';
import { GOYUNIR_STORE_SUITE } from '@/goyunir.config';

export default function NotFoundView() {
  const liveCtx = useLiveTheme();
  const c = { ...GOYUNIR_STORE_SUITE.themeColors, ...(liveCtx?.themeColors || {}) };
  return (
    <main style={{
      minHeight: 'calc(100vh - 56px)',
      background: c.primaryBackground || '#0a0a0a',
      color: c.textMain || '#ffffff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: c.fontFamily || 'system-ui, sans-serif',
    }}>
      <div style={{ textAlign: 'center', maxWidth: '480px' }}>
        <div style={{
          fontSize: '80px',
          marginBottom: '16px',
          color: c.cardBorder || '#333',
        }}>
          404
        </div>
        <h1 style={{
          fontSize: '28px',
          fontFamily: 'serif',
          margin: '0 0 12px',
          fontWeight: 'normal',
          color: c.textMain,
        }}>
          Page Not Found
        </h1>
        <p style={{ color: c.textMuted || '#888', fontSize: '14px', lineHeight: '1.7', marginBottom: '32px' }}>
          This product isn&apos;t available right now. Check out our catalog for what&apos;s currently available.
        </p>
        <Link
          href="/catalog"
          prefetch={false}
          style={{
            padding: '12px 28px',
            borderRadius: 999,
            background: c.textMain || '#ffffff',
            color: c.primaryBackground || '#000000',
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
