import Link from 'next/link';

/**
 * /maintenance — the global maintenance screen shown to unauthenticated
 * visitors when MAINTENANCE_MODE=true. Authenticated admins (Basic Auth) are
 * bypassed by middleware.ts and never see this page. Server component: no
 * client JS, neutral brand (reads env via lib/env.ts).
 */

import { neutralBrandName } from '@/lib/env';

export const dynamic = 'force-dynamic';

export default function MaintenancePage() {
  const brand = neutralBrandName();
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f2f2f7',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '24px',
      }}
    >
      <div style={{ maxWidth: 520, textAlign: 'center' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 72,
            height: 72,
            borderRadius: 22,
            background: '#111',
            color: '#fff',
            fontSize: 30,
            fontWeight: 800,
            margin: '0 auto 24px',
          }}
          aria-hidden
        >
          ⚙
        </div>
        <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, color: '#111' }}>
          {brand} is under maintenance
        </h1>
        <p style={{ fontSize: 16, color: '#4b5563', lineHeight: 1.6, margin: '16px 0 28px' }}>
          We&apos;re making improvements. Please check back shortly — the store will be right back up.
        </p>
        <Link
          href="/admin"
          style={{
            display: 'inline-block',
            padding: '12px 24px',
            borderRadius: 999,
            background: '#111',
            color: '#fff',
            textDecoration: 'none',
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          Operator sign in
        </Link>
      </div>
    </main>
  );
}
