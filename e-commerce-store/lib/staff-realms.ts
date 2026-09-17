/**
 * ─────────────────────────────────────────────────────────────────────────────
 * STAFF REALMS — what each staff portal is CALLED, and where its sign-in lives.
 *
 * THE BUG THIS FIXES. All three staff hosts shared one login route,
 * `/admin/login`. On sales.<root> that was not merely mislabelled — it was a
 * dead end. The sequence, confirmed against lib/edge-router.ts:
 *
 *   1. a rep opens sales.<root>/            -> rewritten to /sales
 *   2. no session, so middleware redirects  -> /admin/login   (reachable: the
 *                                              path fence exempts it)
 *   3. they sign in SUCCESSFULLY
 *   4. the login page sends them to /admin  -> 404. `isPortalPathAllowed`
 *                                              grants /admin to the 'admin' and
 *                                              'merchant' portals only.
 *
 * So a sales rep with correct credentials could never reach the sales hub. The
 * naming confusion ("why am I signing in to admin?") was the visible symptom of
 * a routing fault underneath it.
 *
 * WHY SEPARATE ROUTES RATHER THAN ONE ROUTE WITH PER-HOST COPY. Re-labelling a
 * single `/admin/login` by Host would have left the URL saying `/admin` on the
 * sales portal — half the complaint — and would not have fixed step 4 at all,
 * which needs a per-realm destination regardless. Once a per-realm destination
 * exists, a per-realm path costs nothing and makes the realm legible in the
 * address bar, in bookmarks and in logs.
 *
 * WHAT IS DELIBERATELY NOT DUPLICATED: the auth MECHANISM. All three routes
 * render one component and POST to one endpoint (`/api/admin/login`). Password
 * verification, the login-session cookie and the emailed 2FA device cookie stay
 * in exactly one place. Three copies of an auth flow is how realms drift apart
 * and one of them quietly stops enforcing a step.
 *
 * ZERO imports (mirrors lib/edge-router.ts / lib/csrf.ts) so this loads in the
 * Edge middleware runtime AND under `node --test`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type StaffRealmKey = 'admin' | 'merchant' | 'sales';

export interface StaffRealm {
  key: StaffRealmKey;
  /** Where this realm's sign-in form lives. */
  loginPath: string;
  /** Where a signed-in user of this realm belongs. MUST satisfy
   *  `isPortalPathAllowed` for that realm's portal — that is the whole bug. */
  home: string;
  /** The heading on the sign-in form. Never the word "admin" unless it IS admin. */
  title: string;
  /** One line under the heading, naming who this portal is for. */
  subtitle: string;
  /** Shown when credentials are rejected — names the realm so a rep who typed
   *  the wrong portal's password gets a usable hint instead of "invalid". */
  audience: string;
}

export const STAFF_REALMS: Record<StaffRealmKey, StaffRealm> = {
  admin: {
    key: 'admin',
    loginPath: '/admin/login',
    home: '/admin',
    title: 'Platform admin sign-in',
    subtitle: 'For platform administrators.',
    audience: 'platform admin',
  },
  merchant: {
    key: 'merchant',
    loginPath: '/app/login',
    // The merchant hub is served by the SAME route tree as the platform admin
    // portal today (see lib/edge-router.ts's header) — the difference is the
    // ROLE required, enforced in app/admin/layout.tsx, not the path. When a
    // dedicated merchant tree exists, this is the one line that moves.
    home: '/admin',
    title: 'Merchant sign-in',
    subtitle: 'For store owners and staff.',
    audience: 'merchant',
  },
  sales: {
    key: 'sales',
    loginPath: '/sales/login',
    home: '/sales',
    title: 'Sales sign-in',
    subtitle: 'For sales representatives.',
    audience: 'sales',
  },
};

/**
 * The realm a portal belongs to, or null for a non-staff portal
 * ('storefront', 'marketing') which has no staff sign-in at all.
 *
 * Takes the portal as a plain string rather than importing lib/edge-router's
 * `Portal` type, to keep this module import-free.
 */
export function realmForPortal(portal: string): StaffRealm | null {
  if (portal === 'admin') return STAFF_REALMS.admin;
  if (portal === 'merchant') return STAFF_REALMS.merchant;
  if (portal === 'sales') return STAFF_REALMS.sales;
  return null;
}

/**
 * Where an unauthenticated request on this portal should be sent to sign in.
 *
 * Falls back to `/admin/login` for a portal with no realm. That fallback is
 * what keeps a single-domain deployment (PLATFORM_ROOT_DOMAIN unset, so every
 * host classifies as 'storefront') behaving exactly as it does today.
 */
export function loginPathForPortal(portal: string): string {
  return realmForPortal(portal)?.loginPath ?? STAFF_REALMS.admin.loginPath;
}

/** Every staff login path — what the path fence must keep reachable. */
export const STAFF_LOGIN_PATHS: readonly string[] = [
  STAFF_REALMS.admin.loginPath,
  STAFF_REALMS.merchant.loginPath,
  STAFF_REALMS.sales.loginPath,
];

/**
 * Whether a path is one of the staff sign-in PAGES.
 *
 * Exact match or a trailing slash only — never `startsWith` on the bare
 * string. `/app/login` as a prefix would also match `/app/loginsomething`, and
 * a fence that accidentally exempts a wider surface than intended is how a
 * protected tree becomes reachable.
 */
export function isStaffLoginPath(pathname: string): boolean {
  const p = String(pathname || '');
  return STAFF_LOGIN_PATHS.some((base) => p === base || p.startsWith(base + '/'));
}
