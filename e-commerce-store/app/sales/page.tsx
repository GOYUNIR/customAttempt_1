'use client';

import PortalShell from '@/components/admin/PortalShell';
import QuoteDeskPanel from '@/components/sales/QuoteDeskPanel';

/**
 * SALES HUB — standalone deal-desk portal (app/sales), distinct from the
 * admin panel's Enterprise → B2B Quotes sub-tab (same underlying
 * QuoteDeskPanel component, two mount points — see that component's header).
 *
 * No client-side login form here: middleware.ts already gates every /sales
 * request through the same session-validity checks as /admin (readiness,
 * Basic Auth / login-session / device cookie, 2FA) before this page ever
 * renders — see middleware.ts's `isSalesPath` handling. A `sales`, `owner`,
 * or `super_admin` actor role is what SHOULD additionally gate this page
 * (lib/admin-actor.ts's AdminActorRole) once app/api/admin/b2b/quotes grows
 * a role check of its own; today it only requires ANY valid admin session
 * (adminAuthorized), same as every other /api/admin/b2b route.
 */
export default function SalesHubPage() {
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
