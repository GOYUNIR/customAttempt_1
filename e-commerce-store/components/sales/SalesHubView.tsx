'use client';

import PortalShell from '@/components/admin/PortalShell';
import QuoteDeskPanel from '@/components/sales/QuoteDeskPanel';

/** Client-rendered body of the Sales Hub — split from app/sales/page.tsx so
 *  that page can be a Server Component doing the RBAC redirect (see its
 *  header) before any client JS for the portal ships. */
export default function SalesHubView() {
  return (
    <PortalShell
      title="Sales Hub"
      nav={[
        { label: 'Deal Desk', href: '/sales', active: true },
        { label: 'Admin Panel', href: '/admin' },
      ]}
    >
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Deal Desk</h1>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: '#888' }}>
          Build B2B draft quotes for wholesale/enterprise buyers — Net-30/60 terms and volume tiers are resolved
          from each company&apos;s price list automatically.
        </p>
      </div>
      <QuoteDeskPanel />
    </PortalShell>
  );
}
