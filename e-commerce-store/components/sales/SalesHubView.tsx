'use client';

import { useState } from 'react';
import PortalShell from '@/components/admin/PortalShell';
import QuoteDeskPanel from '@/components/sales/QuoteDeskPanel';
import VolumeDiscountMatrix from '@/components/sales/VolumeDiscountMatrix';
import ImpersonationLauncher from '@/components/sales/ImpersonationLauncher';

type SalesTab = 'quotes' | 'pricing' | 'impersonate';

/** Client-rendered body of the Sales Hub — split from app/sales/page.tsx so
 *  that page can be a Server Component doing the RBAC redirect (see its
 *  header) before any client JS for the portal ships. */
export default function SalesHubView() {
  const [tab, setTab] = useState<SalesTab>('quotes');

  return (
    <PortalShell
      title="Sales Hub"
      portalBadge="DEAL DESK"
      navGroups={[
        {
          label: 'Deal Desk',
          items: [
            { label: 'Quote Builder', href: '#', icon: '📝', active: tab === 'quotes', onClick: () => setTab('quotes') },
            { label: 'Volume Pricing', href: '#', icon: '📊', active: tab === 'pricing', onClick: () => setTab('pricing') },
            { label: 'Impersonation', href: '#', icon: '🔑', active: tab === 'impersonate', onClick: () => setTab('impersonate') },
          ],
        },
        { label: 'Other Portals', items: [{ label: 'Admin Panel', href: '/admin', icon: '⚙️' }] },
      ]}
    >
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>
          {tab === 'quotes' ? 'Quote Builder' : tab === 'pricing' ? 'Volume Pricing & Terms' : 'Customer Impersonation'}
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: '#888' }}>
          {tab === 'quotes'
            ? 'Build B2B draft quotes for wholesale/enterprise buyers — Net-30/60 terms and volume tiers are resolved from each company’s price list automatically.'
            : tab === 'pricing'
              ? 'Review a company’s tiered volume discounts and payment terms before quoting.'
              : 'Assist a merchant by acting on their tenant directly.'}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {(['quotes', 'pricing', 'impersonate'] as SalesTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: '7px 14px',
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              border: tab === t ? '1px solid #3b82f6' : '1px solid #303036',
              background: tab === t ? '#3b82f622' : 'transparent',
              color: tab === t ? '#93c5fd' : '#ccc',
            }}
          >
            {t === 'quotes' ? 'Quotes' : t === 'pricing' ? 'Volume Pricing' : 'Impersonation'}
          </button>
        ))}
      </div>
      {tab === 'quotes' && <QuoteDeskPanel />}
      {tab === 'pricing' && <VolumeDiscountMatrix />}
      {tab === 'impersonate' && <ImpersonationLauncher />}
    </PortalShell>
  );
}
