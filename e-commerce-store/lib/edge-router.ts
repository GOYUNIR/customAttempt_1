/**
 * ─────────────────────────────────────────────────────────────────────────────
 * EDGE ROUTER — pure Host-header classification for portal isolation.
 *
 * This template runs single-tenant (see lib/tenant-context.ts's header) and
 * deploys as ONE Cloudflare Worker (wrangler.jsonc) — there is no separate
 * merchant-control-center APP to route "app.site.com" to yet, so `admin.`
 * and `app.` both serve the same `app/admin` route tree today. They DO get
 * distinct `Portal` values ('admin' vs 'merchant') — not because the tree
 * differs, but because the ROLE required to use it differs per host (zero-
 * trust portal RBAC: admin.site.com is super_admin-only, app.site.com is
 * owner/staff/super_admin) — see `app/admin/layout.tsx`. `isPortalPathAllowed`
 * below is the coarse, host-level half of that; the role check itself needs
 * `lib/admin-verify.ts` (Node-only), so it happens at the route/layout level.
 *
 * `PLATFORM_ROOT_DOMAIN` is unset by default (the common single-domain
 * deployment): every function below degrades to today's behavior (host-only
 * cookies, permissive 'storefront' classification, every portal path
 * allowed) so nothing breaks for a deployment that hasn't configured
 * subdomain DNS. Setting it opts in to real subdomain isolation — see
 * DEPLOYMENT.md's "Edge router / portal DNS setup" section for the exact
 * records to create.
 *
 * ZERO imports (mirrors lib/csrf.ts / lib/rbac.ts) so this loads in the Edge
 * middleware runtime AND under `node --test` with no adapter needed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type Portal = 'marketing' | 'sales' | 'admin' | 'merchant' | 'storefront';

/** Which portal a Host header belongs to, given the configured root domain.
 *  Falls back to 'storefront' for anything unrecognized (localhost, a
 *  preview URL, a merchant's own custom domain via Cloudflare for SaaS) —
 *  the permissive default the rest of the app already assumes today. */
export function classifyHost(host: string, rootDomain: string | undefined): Portal {
  const normalizedHost = String(host || '').trim().toLowerCase().replace(/:\d+$/, '');
  const root = String(rootDomain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!normalizedHost || !root) return 'storefront';
  if (normalizedHost === root) return 'marketing';
  if (!normalizedHost.endsWith(`.${root}`)) return 'storefront';

  const subdomain = normalizedHost.slice(0, -(root.length + 1));
  if (subdomain === 'sales') return 'sales';
  if (subdomain === 'admin') return 'admin';
  if (subdomain === 'app') return 'merchant';
  return 'storefront';
}

/** The `Set-Cookie` `domain` attribute for a portal's session cookies —
 *  `undefined` when no root domain is configured, meaning the cookie stays
 *  host-only (today's behavior, unchanged). A `storefront`/`marketing`
 *  cookie is never domain-scoped here — only the admin/sales/merchant
 *  session cookies this phase partitions (see lib/portal-cookies.ts). */
export function cookieDomainForPortal(portal: Portal, rootDomain: string | undefined): string | undefined {
  const root = String(rootDomain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!root) return undefined;
  if (portal === 'admin') return `admin.${root}`;
  if (portal === 'merchant') return `app.${root}`;
  if (portal === 'sales') return `sales.${root}`;
  return undefined;
}

/**
 * Coarse, Edge-safe "is this Host allowed to reach this path at all" check —
 * the host-level half of zero-trust portal isolation; the per-role half
 * (super_admin vs owner/staff vs sales_*) runs at the route/layout level
 * (`app/admin/layout.tsx`, `app/sales/page.tsx`) since it needs Node's
 * `crypto` (`lib/admin-verify.ts`), unavailable here.
 *
 * `admin` and `merchant` both satisfy `/admin*` — they serve the SAME route
 * tree today (see this file's header); only `/sales*` is portal-exclusive
 * (`sales`, plus `admin` for platform oversight). Every other path is
 * always allowed — this function only ever narrows the two portal trees,
 * never the storefront or marketing pages.
 *
 * No rootDomain configured → always true (today's behavior, unchanged).
 * This is also what guarantees no cross-host redirect loop is possible:
 * every caller either gets `true` (proceed) or `false` (the caller returns
 * a hard 404 — see middleware.ts — never a redirect to a different host).
 */
export function isPortalPathAllowed(pathname: string, portal: Portal, rootDomain: string | undefined): boolean {
  if (!rootDomain) return true;
  const isAdminPath = pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
  const isSalesPath = pathname.startsWith('/sales') || pathname.startsWith('/api/sales');
  if (isAdminPath) return portal === 'admin' || portal === 'merchant';
  if (isSalesPath) return portal === 'sales' || portal === 'admin';
  return true;
}

/** Whether a cross-origin request's `Origin` header may be treated as
 *  same-portal for CORS purposes (distinct from lib/csrf.ts's same-HOST
 *  check — this is for an intentionally cross-subdomain API call, e.g. the
 *  storefront calling a platform API under a different subdomain). Without
 *  a configured root domain, nothing is cross-origin-allowed beyond exact
 *  host match — callers should fall back to their existing same-origin
 *  logic (lib/csrf.ts) in that case. */
export function corsOriginAllowed(origin: string | null, portal: Portal, rootDomain: string | undefined): boolean {
  const root = String(rootDomain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!root || !origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase().replace(/:\d+$/, '');
  } catch {
    return false;
  }
  const originPortal = classifyHost(originHost, root);
  return originPortal === portal;
}
