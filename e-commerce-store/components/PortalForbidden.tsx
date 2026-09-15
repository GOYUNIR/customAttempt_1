/**
 * Shared 403 view for a portal-RBAC rejection (`app/admin/layout.tsx`,
 * `app/sales/page.tsx`) — an authenticated session that simply doesn't have
 * the role this portal requires, distinct from "not signed in at all"
 * (which redirects to `/admin/login` instead of rendering this).
 */
export default function PortalForbidden({ portalName, requiredRoles }: { portalName: string; requiredRoles: string }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0c',
        color: '#e5e5e8',
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#f87171', marginBottom: 10 }}>
          403 · Forbidden
        </div>
        <h1 style={{ margin: '0 0 8px', fontSize: 18 }}>Access denied to {portalName}</h1>
        <p style={{ margin: 0, fontSize: 13, color: '#8b95a7', lineHeight: 1.6 }}>
          Your account is signed in, but this portal requires {requiredRoles}. This attempt has been recorded in the
          platform audit log.
        </p>
      </div>
    </div>
  );
}
