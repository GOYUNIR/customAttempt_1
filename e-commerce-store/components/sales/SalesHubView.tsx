'use client';

import { useState } from 'react';
import PortalShell from '@/components/admin/PortalShell';
import QuoteDeskPanel from '@/components/sales/QuoteDeskPanel';
import VolumeDiscountMatrix from '@/components/sales/VolumeDiscountMatrix';
import ImpersonationLauncher from '@/components/sales/ImpersonationLauncher';
import InDevelopment from '@/components/platform/InDevelopment';

type SalesTab = 'pipeline' | 'quotes' | 'pricing' | 'impersonate';

/** Client-rendered body of the Sales Hub — split from app/sales/page.tsx so
 *  that page can be a Server Component doing the RBAC redirect (see its
 *  header) before any client JS for the portal ships. */
export default function SalesHubView() {
  const [tab, setTab] = useState<SalesTab>('pipeline');

  return (
    <PortalShell
      title="Sales Hub"
      portalBadge="DEAL DESK"
      navGroups={[
        {
          label: 'Deal Desk',
          items: [
            { label: 'Pipeline', href: '#', icon: '📥', active: tab === 'pipeline', onClick: () => setTab('pipeline') },
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
          {tab === 'pipeline' ? 'Pipeline' : tab === 'quotes' ? 'Quote Builder' : tab === 'pricing' ? 'Volume Pricing & Terms' : 'Customer Impersonation'}
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: '#888' }}>
          {tab === 'pipeline'
            ? 'Inbound leads, who owns them, and how long they have been waiting.'
            : tab === 'quotes'
            ? 'Build B2B draft quotes for wholesale/enterprise buyers — Net-30/60 terms and volume tiers are resolved from each company’s price list automatically.'
            : tab === 'pricing'
              ? 'Review a company’s tiered volume discounts and payment terms before quoting.'
              : 'Assist a merchant by acting on their tenant directly.'}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {(['pipeline', 'quotes', 'pricing', 'impersonate'] as SalesTab[]).map((t) => (
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
            {t === 'pipeline' ? 'Pipeline' : t === 'quotes' ? 'Quotes' : t === 'pricing' ? 'Volume Pricing' : 'Impersonation'}
          </button>
        ))}
      </div>
      {tab === 'pipeline' && (
        <InDevelopment
          title="Inbound pipeline and speed to lead"
          worksToday={
            <>
              Quote Builder, Volume Pricing and Impersonation are live — a rep who already
              knows their buyer can price, quote and support them today.
            </>
          }
        >
          <p style={{ margin: '0 0 10px' }}>
            This will list everyone who has asked to talk to us, oldest first, with how long
            they have been waiting. A rep claims a lead, replies, and the time from arrival to
            first reply is recorded — the same speed-to-lead measurement we sell to merchants,
            run on ourselves first.
          </p>
          <p style={{ margin: 0 }}>
            The table that stores these leads is deployed. The capture form and this queue are
            the next thing being built.
          </p>
        </InDevelopment>
      )}
      {tab === 'quotes' && <QuoteDeskPanel />}
      {tab === 'pricing' && <VolumeDiscountMatrix />}
      {tab === 'impersonate' && <ImpersonationLauncher />}
    </PortalShell>
  );
}
