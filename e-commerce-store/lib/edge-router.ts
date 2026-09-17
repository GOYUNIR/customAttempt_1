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
 * Edge-safe: the only import is lib/staff-realms.ts, which is itself
 * import-free, so this whole module still loads in the Edge middleware runtime
 * AND under `node --test` with no adapter needed. That property is load-
 * bearing — anything imported here must stay free of Node built-ins.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { isStaffLoginPath } from './staff-realms.ts';

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
/**
 * Credential-establishing paths shared by every staff portal. These must stay
 * reachable from admin./app./sales. alike. Deliberately narrow: the sign-in
 * PAGES, the shared auth API, the setup wizard (bootstrap, before any
 * credential exists) and staff impersonation sign-in — never /admin itself.
 *
 * Each realm now has its OWN sign-in page (/admin/login, /app/login,
 * /sales/login — lib/staff-realms.ts), but all three stay reachable from all
 * three staff hosts. That is deliberate: a bookmarked or emailed link to the
 * wrong realm's login should render the wrong LABEL, which a person can see and
 * correct, rather than a 404, which reads as "this portal is broken". The
 * session it establishes is cookie-scoped per portal by
 * `cookieDomainForPortal` regardless of which page was used, so this
 * reachability grants no cross-portal access.
 */
function isSharedStaffAuthPath(pathname: string): boolean {
  if (isStaffLoginPath(pathname)) return true;
  return (
    pathname === '/api/admin/login' ||
    pathname.startsWith('/api/admin/login/') ||
    pathname === '/admin/setup' ||
    pathname.startsWith('/admin/setup/') ||
    pathname === '/api/admin/setup' ||
    pathname.startsWith('/api/admin/setup/') ||
    pathname === '/api/admin/impersonate' ||
    pathname === '/api/admin/super-login'
  );
}

/**
 * Is this the MERCHANT hub tree (app.<root>'s own paths)?
 *
 * Matched exactly or with a trailing slash — never `startsWith('/app')`, which
 * would also swallow a storefront route like /apparel and hand it to the portal
 * fence. A fence that matches more than it means to is how a public page
 * becomes a 404 for everyone outside the portal.
 */
function isMerchantPath(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

export function isPortalPathAllowed(pathname: string, portal: Portal, rootDomain: string | undefined): boolean {
  if (!rootDomain) return true;
  // Each staff realm has its own sign-in page, and all three stay reachable
  // from all three staff hosts. Without this exemption the sales portal is
  // unusable: middleware redirects an unauthenticated /sales request to a
  // login page, which the fence would then 404 on that same host, so a rep is
  // bounced into a dead end and can never sign in. Confirmed live before it
  // was first fixed: sales.goyunir.com/admin/login returned 404.
  //
  // Only the credential-establishing endpoints are exempt, never /admin itself
  // -- which is the OTHER half of the same bug: /admin was the post-sign-in
  // destination for EVERY realm, so a sales rep signed in successfully and
  // landed on a 404. That half is fixed in lib/staff-realms.ts by giving each
  // realm its own home.
  if (isSharedStaffAuthPath(pathname)) {
    return portal === 'admin' || portal === 'merchant' || portal === 'sales';
  }
  const isAdminPath = pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
  const isSalesPath = pathname.startsWith('/sales') || pathname.startsWith('/api/sales');
  if (isAdminPath) return portal === 'admin' || portal === 'merchant';
  if (isSalesPath) return portal === 'sales' || portal === 'admin';
  if (isMerchantPath(pathname)) return portal === 'merchant' || portal === 'admin';
  return true;
}

/**
 * On a STAFF host, is this path consumer-storefront surface that does not
 * belong there?
 *
 * THE BUG THIS FIXES, reported as "clicking the logo sends you to
 * sales.goyunir.com/admin/login". The logo's href is `/`, which is correct.
 * The fault was that sales.<root>/catalog served the whole consumer storefront
 * — `isPortalPathAllowed` only ever narrowed /admin and /sales, so every other
 * path fell through to `return true` on every host. From that page the logo's
 * `/` resolves against the STAFF host, where it rewrites to the portal home,
 * which is unauthenticated, which redirects to the sign-in page.
 *
 * So it was never a broken link. It was the storefront being served somewhere
 * it should never appear — which is also a portal-isolation hole in its own
 * right: the cart, /account and the checkout routes were all reachable on
 * admin., app. and sales.
 *
 * WHAT STAYS REACHABLE on a staff host, deliberately:
 *   - that portal's own tree, and the shared staff auth paths
 *   - everything under /api/, because the portal UIs call a wide and changing
 *     set of endpoints (/api/config-check, /api/store, /api/admin/*, …).
 *     Fencing those by guesswork would break the portal to fix a link.
 *   - /og and /icon, which generate the tab icon and share images
 *
 * Returns false for every non-staff portal, so the storefront and marketing
 * hosts are completely untouched.
 */
export function isStrayStorefrontPath(pathname: string, portal: Portal): boolean {
  if (portal !== 'admin' && portal !== 'merchant' && portal !== 'sales') return false;
  if (pathname.startsWith('/api/')) return false;
  if (pathname === '/og' || pathname.startsWith('/og/')) return false;
  if (pathname === '/icon' || pathname.startsWith('/icon/')) return false;
  if (isSharedStaffAuthPath(pathname)) return false;
  // The portal's own tree. `/` never reaches here — portalHomeRewrite has
  // already turned it into the portal home.
  if (pathname.startsWith('/admin') || pathname.startsWith('/sales')) return false;
  if (isMerchantPath(pathname)) return false;
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

export type PortalIsolationStatus = 'active' | 'single-domain' | 'misconfigured';

/**
 * Whether portal isolation is actually in force — the fail-closed check
 * (ARCHITECTURE.md, Phase A2).
 *
 * Every function above degrades to "no isolation" when `PLATFORM_ROOT_DOMAIN`
 * is unset. That is correct for local dev and dangerous in production, where
 * it silently means `/admin` is reachable from any host (including a
 * merchant's own custom storefront domain) and the per-portal role split is
 * off.
 *
 * This deliberately does NOT block at runtime: hard-404ing `/admin` on a
 * missing env var would lock an operator out of their own portal, which this
 * codebase has consistently refused to do. Instead it fails closed at the
 * DEPLOY GATE — `checkPortalIsolation()` (lib/system-diagnostics-pure.ts)
 * turns 'misconfigured' into an error-level readiness check, so
 * `scripts/production-readiness-check.ts` exits non-zero and the admin System
 * Health panel goes red. You cannot ACCIDENTALLY ship unisolated; you can
 * still deliberately run single-domain by setting
 * `PLATFORM_SINGLE_DOMAIN_MODE=true`.
 */
export function portalIsolationStatus(
  env: Record<string, string | undefined> = process.env,
): PortalIsolationStatus {
  if (String(env.PLATFORM_ROOT_DOMAIN || '').trim()) return 'active';
  if (String(env.PLATFORM_SINGLE_DOMAIN_MODE || '').trim().toLowerCase() === 'true') return 'single-domain';
  if (env.NODE_ENV !== 'production') return 'single-domain';
  return 'misconfigured';
}

/**
 * Host-to-tier home rewrite (Phase C).
 *
 * `/` serves the consumer storefront on every host today, so a staff host like
 * admin.<root> lands visitors on a shop homepage and expects them to know to
 * type /admin. This maps the ROOT PATH ONLY to each tier's real entry point:
 *
 *   admin.<root>/   -> /admin     (platform admin)
 *   app.<root>/     -> /admin     (merchant hub — same tree, role-differentiated
 *                                  at app/admin/layout.tsx, see Phase 4)
 *   sales.<root>/   -> /sales     (sales hub)
 *   <root>/ and *.<root>/         -> unchanged (marketing / tenant storefront)
 *
 * Returns the path to rewrite to, or null to leave the request alone.
 *
 * SECURITY: the caller MUST fold this into the pathname it uses for its auth
 * checks BEFORE running them, and only emit the actual rewrite at the end of
 * the chain. A `NextResponse.rewrite` returned early ends middleware for that
 * request, so the rewritten path would be served with NO session check — i.e.
 * the admin UI, unauthenticated, on the one host that is supposed to be the
 * most protected. middleware.ts does this via `effectivePathname`.
 *
 * Only the exact root path is rewritten. Every other path is left as-is so
 * this can never shadow a real route or interact with the path fence.
 */
export function portalHomeRewrite(pathname: string, portal: Portal): string | null {
  if (pathname !== '/') return null;
  if (portal === 'admin' || portal === 'merchant') return '/admin';
  if (portal === 'sales') return '/sales';
  return null;
}

/**
 * Resolve the PUBLIC host of a request, for portal classification.
 *
 * `request.nextUrl.host` is NOT reliable for host-based routing: in local dev
 * it is the server's own address (`localhost:3000`), not the Host header. That
 * makes `classifyHost` return 'storefront' for every request, so portal
 * isolation silently does nothing and — worse — cannot be verified locally at
 * all before deploying. Verified directly against `next dev`: a request with
 * `Host: admin.goyunir.com` produced `nextUrl.host === 'localhost:3111'`.
 *
 * Order: `x-forwarded-host` (set by proxies/CDNs, first value wins) → `host` →
 * the caller's fallback. The result is lowercased and stripped of any port.
 *
 * SECURITY: `Host`/`x-forwarded-host` are client-supplied, so this is NOT an
 * authentication input and must never be treated as one. A spoofed Host can
 * at most make the path fence *more* permissive for that request — it still
 * has to pass the session checks in middleware.ts, which key off the path, not
 * the host. That separation is exactly why those path-based auth triggers must
 * not be removed in favor of host classification.
 */
export function resolveRequestHost(
  headers: { xForwardedHost?: string | null; host?: string | null },
  fallback = '',
): string {
  const forwarded = String(headers.xForwardedHost || '').split(',')[0].trim();
  const direct = String(headers.host || '').trim();
  return (forwarded || direct || fallback).toLowerCase().replace(/:\d+$/, '');
}
