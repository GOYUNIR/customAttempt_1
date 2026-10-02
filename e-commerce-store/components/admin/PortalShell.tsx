'use client';

import { useState, type ReactNode } from 'react';

/**
 * PORTAL SHELL — the high-density dashboard chrome shared by the Platform
 * Admin, Merchant Hub, and Sales Hub portals. Rebuilt for Phase 5's "high-
 * density visual overhaul": grouped sidebar sections with icons, a top bar
 * (portal badge + actor context), and a content area sized for dashboard
 * card grids — replacing the flat single-list nav from the original
 * version. Still re-chromes existing content rather than rewriting it —
 * `app/admin/page.tsx`'s deep tab logic and `components/sales/QuoteDeskPanel.tsx`
 * are unchanged, only mounted inside this shell (see DEPLOYMENT.md's Phase
 * 5 notes on exactly where that line is drawn).
 *
 * The "workspace" label is honestly static — this template runs single-
 * tenant (`lib/tenant-context.ts`'s `DEFAULT_TENANT_ID`), so there is no
 * real multi-merchant list to switch between yet (see
 * `TenantOnboardingWizard.tsx` for the real, if schema-only, first step
 * toward that).
 */

export type PortalNavItem = {
  label: string;
  /** Real navigation target. Ignored when `onClick` is set (renders a
   *  <button> instead of a link, for in-page tab-switching sidebars like
   *  app/admin/page.tsx's — see that file for why: it's one giant client
   *  component with local tab state, not a set of real routes). */
  href: string;
  icon?: string;
  active?: boolean;
  onClick?: () => void;
  badge?: number;
};

export type PortalNavGroup = {
  label: string;
  items: PortalNavItem[];
};

export default function PortalShell({
  title,
  portalBadge,
  workspaceLabel = 'Default Workspace',
  navGroups,
  actorEmail,
  children,
}: {
  title: string;
  /** Short badge naming which portal this is (e.g. "PLATFORM ADMIN", "MERCHANT HUB", "SALES HUB"). */
  portalBadge?: string;
  workspaceLabel?: string;
  navGroups: PortalNavGroup[];
  actorEmail?: string;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Picking a destination on a phone closes the drawer, so the content shows.
  const wrap = (item: PortalNavItem): PortalNavItem => (item.onClick ? { ...item, onClick: () => { setMenuOpen(false); item.onClick!(); } } : item);
  return (
    <div className="ps-root" style={{ display: 'flex', minHeight: '100vh', background: '#08080a', color: '#e5e5e8', fontFamily: 'system-ui, sans-serif' }}>
      {/* Layout that inline styles cannot express: under 800px the sidebar
          is an off-canvas drawer behind a "Menu" button, so the content gets
          the full width (it used to keep ~135px of a 375px phone). */}
      <style>{`
        .ps-aside { width: 240px; flex-shrink: 0; position: sticky; top: 0; height: 100vh; }
        .ps-topbar { display: none; }
        .ps-scrim { display: none; }
        @media (max-width: 799px) {
          .ps-aside { position: fixed; left: 0; top: 0; z-index: 60; width: min(280px, 85vw); background: #08080a; transform: translateX(-100%); transition: transform .2s ease; }
          .ps-aside.ps-open { transform: none; box-shadow: 0 0 40px rgba(0,0,0,.6); }
          .ps-scrim.ps-open { display: block; position: fixed; inset: 0; z-index: 55; background: rgba(0,0,0,.5); }
          .ps-topbar { display: flex; position: sticky; top: 0; z-index: 40; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px; background: #08080a; border-bottom: 1px solid #1f1f24; }
          .ps-main { padding: 16px 16px 40px !important; }
        }
      `}</style>
      <div className={'ps-scrim' + (menuOpen ? ' ps-open' : '')} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside
        id="portal-menu"
        className={'ps-aside' + (menuOpen ? ' ps-open' : '')}
        aria-label="Portal menu"
        style={{
          borderRight: '1px solid #1f1f24',
          padding: '18px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          overflowY: 'auto',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.2px' }}>{title}</div>
            {portalBadge && (
              <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '0.6px', padding: '2px 7px', borderRadius: 999, background: '#3b82f622', color: '#93c5fd', border: '1px solid #3b82f655' }}>
                {portalBadge}
              </span>
            )}
          </div>
          <div
            title="Single-tenant deployment — no other workspace to switch to yet"
            style={{
              marginTop: 10,
              padding: '9px 10px',
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
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspaceLabel}</span>
            <span style={{ fontSize: 9, color: '#6b7280', flexShrink: 0 }}>▾</span>
          </div>
        </div>

        {navGroups.map((group) => (
          <div key={group.label}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#565660', padding: '0 8px 6px' }}>{group.label}</div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {group.items.map(wrap).map((item) => {
                const itemStyle = {
                  display: 'flex' as const,
                  alignItems: 'center' as const,
                  gap: 9,
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: 600,
                  textDecoration: 'none',
                  border: 'none',
                  background: item.active ? '#3b82f61f' : 'transparent',
                  color: item.active ? '#93c5fd' : '#ccc',
                  cursor: 'pointer',
                  textAlign: 'left' as const,
                  fontFamily: 'inherit',
                };
                const content = (
                  <>
                    {item.icon && <span style={{ fontSize: 13, width: 16, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>}
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                    {typeof item.badge === 'number' && item.badge > 0 && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: '#edb210', color: '#000' }}>{item.badge}</span>
                    )}
                  </>
                );
                return item.onClick ? (
                  <button key={item.label} type="button" onClick={item.onClick} style={itemStyle}>
                    {content}
                  </button>
                ) : (
                  <a key={item.href} href={item.href} style={itemStyle}>
                    {content}
                  </a>
                );
              })}
            </nav>
          </div>
        ))}

        <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid #1a1a1e' }}>
          {actorEmail && <div style={{ fontSize: 10.5, color: '#565660', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{actorEmail}</div>}
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="ps-topbar">
          <div style={{ fontSize: 13, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          <button type="button" onClick={() => setMenuOpen(true)} aria-expanded={menuOpen} aria-controls="portal-menu"
            style={{ minHeight: 40, padding: '0 14px', borderRadius: 999, border: '1px solid #2a2a31', background: '#141417', color: '#e5e5e8', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            Menu
          </button>
        </div>
        <main className="ps-main" style={{ flex: 1, padding: '22px 28px 40px', minWidth: 0 }}>{children}</main>
      </div>
    </div>
  );
}

/** A responsive dashboard-card grid — used by TelemetryDashboard and any
 *  page that wants a real card layout instead of a single-column stack. */
export function DashboardGrid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>{children}</div>
  );
}
