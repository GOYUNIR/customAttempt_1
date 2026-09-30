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
  // Opens on a tool that works today; the in-development pipeline is last
  // (a rep's first screen should not be a placeholder).
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
            { label: 'Pipeline (coming)', href: '#', icon: '📥', active: tab === 'pipeline', onClick: () => setTab('pipeline') },
          ],
        },
        // No "Admin Panel" link: /admin does not exist on the sales host (404).
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
      {/* One navigation: the sidebar. (A second row of tab pills to the same four
          places doubled every choice.) */}
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
