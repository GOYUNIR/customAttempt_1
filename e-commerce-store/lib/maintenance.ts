/**
 * MAINTENANCE MODE — a global `MAINTENANCE_MODE` toggle.
 *
 * When ON, unauthenticated visitors are redirected to `/maintenance` while
 * authenticated Admin users (Basic Auth / 2FA device cookie / super-admin
 * session) BYPASS the screen and view the public site normally.
 *
 * The flag is environment-only by design (no Redis key): flipping it is an
 * ops-level action (`npx wrangler secret put MAINTENANCE_MODE`, set it to
 * `true`), and it can never be toggled by a customer through the storefront.
 *
 * DESIGN — ZERO-import so `node --test` loads it directly.
 */

/** Normalize a raw env value into a boolean. Truthy strings: true/1/on/yes. */
export function parseMaintenanceFlag(value: unknown): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on' || v === 'yes';
}

/** Whether maintenance mode is currently enabled. */
export function maintenanceModeEnabled(): boolean {
  return parseMaintenanceFlag(process.env.MAINTENANCE_MODE);
}

/** Paths that must remain reachable even during maintenance (the screen itself,
 *  static assets, and the admin/auth surface that lets an admin sign in). */
export function isMaintenanceExemptPath(pathname: string): boolean {
  const p = String(pathname || '/');
  if (p === '/maintenance' || p.startsWith('/maintenance')) return true;
  if (p.startsWith('/api/admin') || p.startsWith('/admin')) return true;
  if (p.startsWith('/api/auth')) return true;
  if (p === '/og' || p === '/icon' || p.startsWith('/og?') || p.startsWith('/icon?')) return true;
  if (p.startsWith('/_next/') || p.startsWith('/media/') || p.startsWith('/favicon')) return true;
  if (/\.(ico|png|jpg|jpeg|svg|webp|css|js|json|txt|xml)$/i.test(p)) return true;
  return false;
}
