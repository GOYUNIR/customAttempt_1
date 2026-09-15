'use client';

import type { ReactNode } from 'react';

/**
 * PORTAL SHELL — a sidebar-nav chrome shared by the admin panel and the
 * Sales Hub. Re-chromes existing content; it does not rewrite it (app/admin/
 * page.tsx's tabs and components/sales/QuoteDeskPanel.tsx are unchanged, only
 * wrapped).
 *
 * The "workspace" label is honestly static — this template runs single-
 * tenant (lib/tenant-context.ts's DEFAULT_TENANT_ID), so there is no real
 * multi-merchant list to switch between yet. It's an affordance placeholder,
 * not a functional switcher; making it real is future work once this
 * template supports onboarding more than one tenant.
 */

export type PortalNavItem = {
  label: string;
  href: string;
  active?: boolean;
};

export default function PortalShell({
  title,
  workspaceLabel = 'Default Workspace',
  nav,
  children,
}: {
  title: string;
  workspaceLabel?: string;
  nav: PortalNavItem[];
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0c', color: '#e5e5e8' }}>
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: '1px solid #1f1f24',
          padding: '20px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#6b7280', fontWeight: 700 }}>{title}</div>
          <div
            title="Single-tenant deployment — no other workspace to switch to yet"
            style={{
              marginTop: 6,
              padding: '8px 10px',
              borderRadius: 10,
              background: '#141417',
              border: '1px solid #24242a',
              fontSize: 12,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              cursor: 'default',
            }}
          >
            <span>{workspaceLabel}</span>
            <span style={{ fontSize: 9, color: '#6b7280' }}>▾</span>
          </div>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              style={{
                padding: '9px 10px',
                borderRadius: 8,
                fontSize: 12.5,
                fontWeight: 600,
                textDecoration: 'none',
                color: item.active ? '#93c5fd' : '#ccc',
                background: item.active ? '#3b82f622' : 'transparent',
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, padding: 24, minWidth: 0 }}>{children}</main>
    </div>
  );
}
