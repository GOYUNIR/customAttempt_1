import type { CSSProperties } from 'react';

/**
 * PORTAL STYLES — shared inline-style tokens + fetch helper for the admin
 * portal (components/admin/EnterprisePanel.tsx) and the Sales Hub
 * (components/sales/QuoteDeskPanel.tsx, app/sales/page.tsx). Pulled out of
 * EnterprisePanel.tsx (where these were previously module-local) so the two
 * portals stay visually consistent without duplicating the same object
 * literals. Follows the codebase's existing inline-style-in-JS convention
 * (Tailwind is installed but unused stylistically today) rather than
 * introducing a new styling approach mid-refactor.
 */

export const panelStyle: CSSProperties = {
  padding: 22,
  borderRadius: 18,
  background: '#141417',
  border: '1px solid #2a2a30',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.14)',
};

export const inputStyle: CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: '#0d0d10',
  border: '1px solid #303036',
  color: '#fff',
  fontSize: 13,
  boxSizing: 'border-box',
};

export const buttonPrimary: CSSProperties = {
  padding: '9px 16px',
  borderRadius: 10,
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

export const buttonGhost: CSSProperties = {
  padding: '9px 16px',
  borderRadius: 10,
  background: 'transparent',
  color: '#ccc',
  border: '1px solid #303036',
  fontSize: 12,
  cursor: 'pointer',
};

export const labelStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.6px',
  textTransform: 'uppercase',
  color: '#8b95a7',
};

export const statusPill = (color: string): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 10.5,
  fontWeight: 600,
  textTransform: 'uppercase',
  color,
  background: `${color}22`,
  border: `1px solid ${color}55`,
});

/** Cookie-authenticated fetch to an /api/admin/* (or /api/sales/*) route —
 *  the session cookie set by /api/admin/login (portalCookieAttrs, lib/
 *  portal-cookies.ts) is what actually authorizes the request. */
export async function adminApiFetch(input: string, init: RequestInit = {}) {
  return fetch(input, { ...init, credentials: 'include' });
}
