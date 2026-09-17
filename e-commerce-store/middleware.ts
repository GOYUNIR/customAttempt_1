import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createStorageClient } from '@/lib/storage';
import { ADMIN_DEVICES_KEY, ADMIN_AUTH_PREFIX } from '@/lib/redis-keys';
import { isPlatformConfiguredEdge, supabaseEnvReady } from '@/services/config/edge';
import { computeAdminReady, detectStorageDrivers } from '@/lib/env-discovery';
import { licenseEnforced, resolveLicenseKey } from '@/lib/license';
import { maintenanceModeEnabled, isMaintenanceExemptPath } from '@/lib/maintenance';
import { isCsrfBlocked } from '@/lib/csrf';
import { productionEnvHasBlockingIssues } from '@/lib/env-schema';
import { classifyHost, isPortalPathAllowed, isStrayStorefrontPath, portalHomeRewrite, resolveRequestHost, type Portal } from '@/lib/edge-router';
import { loginPathForPortal, isStaffLoginPath } from '@/lib/staff-realms';


// The admin signs in with their EMAIL (not a username). The Basic Auth
// "username" field now accepts the admin email — resolved from
// ADMIN_VERIFY_EMAIL → SUPPORT_EMAIL → REPLY_TO_EMAIL. When none is set the
// email check is skipped (the password is the secret), so a bare password-only
// setup keeps working.
const ADMIN_EMAIL = resolveAdminEmail();
const ADMIN_PASSWORD = resolveAdminPassword();

/**
 * Edge-safe resolution of the admin password. Mirrors `getAdminPassword()` in
 * lib/server-config.ts: in production the value MUST come from
 * ADMIN_BASIC_AUTH_PASSWORD; outside production the documented local dev
 * fallback is allowed so the admin portal stays usable on a fresh clone.
 *
 * This is inlined here (instead of importing from lib/server-config.ts)
 * because this file compiles to the EDGE runtime on Cloudflare Workers, and
 * lib/server-config.ts pulls in Node-only modules (`stripe`, `crypto`,
 * Resend) that are unavailable in the V8 / workerd environment.
 */
function resolveAdminPassword(): string {
  const configured = process.env.ADMIN_BASIC_AUTH_PASSWORD;
  if (configured) return configured;
  if (process.env.NODE_ENV !== 'production') return 'goyunir-admin-dev';
  return '';
}

/**
 * The admin EMAIL used for the Basic Auth "username" field. Mirrors
 * `getAdminVerifyEmail()` in lib/server-config.ts — inlined edge-safe here.
 */
function resolveAdminEmail(): string {
  const direct = (process.env.ADMIN_VERIFY_EMAIL || '').trim();
  if (direct) return direct;
  // In older setups the admin email was stored in ADMIN_BASIC_AUTH_USERNAME.
  // Honor it so those installs keep signing in by email (same as
  // getAdminVerifyEmail() in lib/server-config.ts).
  const basicAuthUser = (process.env.ADMIN_BASIC_AUTH_USERNAME || '').trim();
  if (basicAuthUser) return basicAuthUser;
  const support = (process.env.SUPPORT_EMAIL || process.env.REPLY_TO_EMAIL || '').trim();
  if (support) return support;
  if (process.env.NODE_ENV !== 'production') return 'admin@localhost.dev';
  return '';
}

/**
 * Constant-time string comparison that works in the middleware (Edge) runtime
 * where Node's crypto.timingSafeEqual is unavailable. Length is compared first
 * (the same information timingSafeEqual leaks), then every byte is XORed
 * together so a timing attacker can never learn the password one character at
 * a time.
 */
function timingSafeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * These endpoints ARE the two-step verification flow, so they are reachable
 * with Basic Auth alone. Every OTHER /api/admin request additionally requires
 * a valid device cookie (issued by verify-confirm after an emailed code).
 */
const TWO_FA_EXEMPT = [
  '/api/admin/verify-start',
  '/api/admin/verify-send',
  '/api/admin/verify-confirm',
  '/api/admin/verify-status',
];

function verifyBasicAuth(authorization: string | null) {
  if (!authorization?.startsWith('Basic ')) return false;
  const encoded = authorization.slice(6);
  let decoded = '';
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);
  // The admin signs in with their EMAIL (not a username). When no admin email
  // is configured the email comparison is skipped — the password is the secret.
  const emailOk = !ADMIN_EMAIL || timingSafeStringEq(user, ADMIN_EMAIL);
  return emailOk && timingSafeStringEq(pass, ADMIN_PASSWORD);
}

/** Best-effort client IP from the standard proxy headers. Mirrors
 *  `clientIp()` in lib/rate-limit.ts — duplicated here (rather than
 *  imported) for the same reason every other helper in this file is:
 *  lib/rate-limit.ts pulls in lib/server-config.ts's Node-only imports
 *  (stripe, crypto) which the Edge runtime can't load. */
function edgeClientIp(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'unknown';
  return request.headers.get('x-real-ip') || 'unknown';
}

/**
 * Rate-limit HTTP Basic-Auth attempts against /admin* (page + every API
 * route) — the ONE credential check in the whole admin auth chain that had
 * no throttle at all. Every route-level password re-check (verify-start,
 * verify-send, verify-confirm, /api/admin/login, …) sits BEHIND this gate,
 * so an attacker sending `Authorization: Basic <guess>` directly could brute
 * force the admin password against literally any /api/admin/* path with
 * zero throttling, bypassing every route-level limiter entirely. Counts
 * EVERY attempt that carries a Basic-Auth header (mirrors how /api/admin/login
 * counts every attempt, not just failures) so a compromised/scripted client
 * can't burn through guesses just by never quite getting it right.
 */
async function basicAuthRateLimited(storage: ReturnType<typeof createStorageClient>, request: NextRequest): Promise<boolean> {
  if (!storage) return false;
  try {
    const key = `cache:rate:admin_basicauth:${edgeClientIp(request)}`;
    const count = await storage.incr(key);
    if (Number(count) === 1) await storage.expire(key, 60);
    return Number(count) > 20;
  } catch {
    return false; // a limiter hiccup must never lock a legitimate admin out
  }
}
/**
 * Edge-safe minimal JSON parse for Redis values. Mirrors
 * `safeParseKvItem()` in lib/server-config.ts ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Upstash REST Redis
 * auto-deserializes JSON, so stored values can arrive as ALREADY-PARSED
 * objects (`String(object)` would be `"[object Object]"`).
 */
function parseStoredValue(item: unknown): unknown {
  if (item == null) return null;
  if (typeof item === 'object') return item;
  if (typeof item === 'string') {
    try {
      return JSON.parse(item);
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract the device token from the request's Cookie header. Mirrors
 *  `adminDeviceTokenFromRequest()` in lib/admin-verify.ts (inlined here ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the
 *  Edge runtime cannot import that module because it pulls in Node `crypto`). */
function adminDeviceTokenFromRequest(request: NextRequest): string {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)goyunir_admin_device=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Whether a device token is currently valid. Mirrors `isAdminDeviceValid()`
 *  in lib/admin-verify.ts ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â inlined edge-safe (no `crypto`, no `email`, no
 *  Stripe). Lazy expiry: an expired token is removed the first time it is
 *  checked so `admin:devices` self-cleans. */
async function adminDeviceValid(redis: any, token: string): Promise<boolean> {
  if (!token) return false;
  const raw = await redis.hget(ADMIN_DEVICES_KEY, token).catch(() => null);
  if (!raw) return false;
  const parsed = parseStoredValue(raw) as { email?: string; createdAt?: number; expiresAt?: number } | null;
  if (!parsed) return false;
  if (Number(parsed.expiresAt) > 0 && Date.now() > Number(parsed.expiresAt)) {
    try {
      await redis.hdel(ADMIN_DEVICES_KEY, token);
    } catch {
      /* best-effort */
    }
    return false;
  }
  return Boolean(parsed.email || parsed.createdAt);
}

/** Whether a device token maps to a SUPER-ADMIN session (created by
 *  /api/admin/super-login after a Supabase master-account sign-in). Mirrors the
 *  `superAdmin` marker stored on `admin:devices`; inlined edge-safe. */
async function adminDeviceIsSuperAdmin(redis: any, token: string): Promise<boolean> {
  if (!token) return false;
  const raw = await redis.hget(ADMIN_DEVICES_KEY, token).catch(() => null);
  if (!raw) return false;
  const parsed = parseStoredValue(raw) as { email?: string; createdAt?: number; expiresAt?: number; superAdmin?: boolean } | null;
  if (!parsed) return false;
  if (Number(parsed.expiresAt) > 0 && Date.now() > Number(parsed.expiresAt)) {
    try {
      await redis.hdel(ADMIN_DEVICES_KEY, token);
    } catch {
      /* best-effort */
    }
    return false;
  }
  return parsed.superAdmin === true;
}

/** Extract the in-site login-session token from the Cookie header. Mirrors
 *  `adminAuthTokenFromRequest()` in lib/admin-verify.ts (inlined edge-safe). */
function adminAuthTokenFromRequest(request: NextRequest): string {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)goyunir_admin_auth=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Whether an in-site login-session token is valid. Returns the verified admin
 *  email, or null when missing/unknown/expired. Login sessions are TTL strings
 *  (`admin:auth:<token>`), so they self-expire without any lazy-cleanup sweep. */
async function adminAuthValid(redis: any, token: string): Promise<string | null> {
  if (!token) return null;
  const raw = await redis.get(`${ADMIN_AUTH_PREFIX}:${token}`).catch(() => null);
  if (!raw) return null;
  const parsed = parseStoredValue(raw) as { email?: string; createdAt?: number } | null;
  const email = String(parsed?.email || '').trim().toLowerCase();
  return email || null;
}

/**
 * Send an unauthenticated staff request to ITS OWN portal's sign-in page.
 *
 * `portal` is passed in rather than re-derived here: this used to send every
 * portal to /admin/login, which told a sales rep they were signing in to an
 * admin panel and — because the login page then returned everyone to /admin —
 * dropped them on a 404 that the path fence produces for /admin on the sales
 * host. See lib/staff-realms.ts.
 *
 * The JSON `redirect` for API callers is realm-correct for the same reason:
 * a client that follows it must land somewhere it is allowed to be.
 */
function adminAuthRequired(request: NextRequest, portal: Portal) {
  const loginPath = loginPathForPortal(portal);
  if (request.nextUrl.pathname.startsWith('/api/admin') || request.nextUrl.pathname.startsWith('/api/sales')) {
    return NextResponse.json(
      { error: 'AUTH_REQUIRED', redirect: loginPath },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = loginPath;
  url.search = '';
  return NextResponse.redirect(url, { headers: { 'Cache-Control': 'no-store' } });
}

export async function middleware(request: NextRequest) {
  // CSRF gate — see lib/csrf.ts for the full rationale (Origin/Referer
  // verification on cookie-authenticated writes, in place of a synchronized
  // token that would have to be plumbed through every fetch() call).
  const csrfBlocked = isCsrfBlocked({
    method: request.method,
    pathname: request.nextUrl.pathname,
    cookieHeader: request.headers.get('cookie') || '',
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    requestHost: request.nextUrl.host,
  });
  if (csrfBlocked) {
    return NextResponse.json(
      { error: 'Cross-site request blocked (Origin did not match this site).' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const pathname = request.nextUrl.pathname;

  // ── EDGE ROUTER — portal isolation (opt-in via PLATFORM_ROOT_DOMAIN) ─────
  // lib/edge-router.ts classifies the Host header into a portal. Unset (the
  // common single-domain deployment today), this is a no-op — classifyHost
  // always returns 'storefront' and nothing below fires, so behavior is
  // byte-for-byte unchanged. Configured, it stops the admin/sales portals
  // from ever being reachable on a tenant's own storefront domain or the
  // bare marketing host — see DEPLOYMENT.md's edge-router setup section.
  const platformRootDomain = process.env.PLATFORM_ROOT_DOMAIN || undefined;
  // The PUBLIC host, from the Host header — not request.nextUrl.host, which is
  // the server's own address in dev (localhost:PORT) and would classify every
  // request as 'storefront', making portal isolation a silent no-op that could
  // not be verified locally. See resolveRequestHost in lib/edge-router.ts.
  const publicHost = resolveRequestHost(
    { xForwardedHost: request.headers.get('x-forwarded-host'), host: request.headers.get('host') },
    request.nextUrl.host,
  );
  const portal = classifyHost(publicHost, platformRootDomain);
  // Host-to-tier home rewrite (Phase C). Computed HERE, ahead of every auth
  // gate, and folded into `effectivePathname` so the session checks below run
  // against the path that will ACTUALLY be served. The rewrite response itself
  // is emitted only at the very END of this chain: returning it early would end
  // middleware for this request and serve /admin with no session check at all.
  const portalRewriteTarget = portalHomeRewrite(pathname, portal);
  const effectivePathname = portalRewriteTarget ?? pathname;
  // NOTE: these are the AUTHENTICATION triggers ("does this path require a staff
  // session?"), NOT redundant path-based access control. isPortalPathAllowed below
  // answers a different question ("may this host serve this path?"). Deleting
  // these does not tighten isolation — it removes auth from /admin entirely.
  const isAdminPath = effectivePathname.startsWith('/admin') || effectivePathname.startsWith('/api/admin');
  const isSalesPath = effectivePathname.startsWith('/sales') || effectivePathname.startsWith('/api/sales');
  // Coarse, Edge-safe host/path gate — see lib/edge-router.ts's
  // isPortalPathAllowed for why this can never produce a cross-host
  // redirect loop (it only ever returns a hard 404 here, never a redirect).
  // The finer per-ROLE split (super_admin vs owner/staff vs sales_*) runs
  // at the route/layout level (app/admin/layout.tsx, app/sales/page.tsx).
  if (!isPortalPathAllowed(pathname, portal, platformRootDomain)) {
    return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  // A staff host must not serve the consumer storefront. It used to: every
  // path that was not /admin or /sales fell through the fence, so
  // sales.<root>/catalog rendered the full shop — cart, /account and checkout
  // included. The visible symptom was the header logo, whose correct `/` href
  // resolved against the staff host and bounced the user to a sign-in page.
  //
  // A REDIRECT to the portal home rather than a 404: these are real pages that
  // exist, reached on the wrong host, usually from a stray link or a bookmark.
  // Sending the person where they meant to go beats telling them the page does
  // not exist. Only reached when platformRootDomain is set, so single-domain
  // deployments never see it.
  if (platformRootDomain && isStrayStorefrontPath(pathname, portal)) {
    const portalHome = portalHomeRewrite('/', portal);
    if (portalHome) {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = portalHome;
      homeUrl.search = '';
      return NextResponse.redirect(homeUrl, { headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // The Setup Wizard is ALSO the "re-configure providers" page: once the
  // platform is configured, visiting /admin/setup?reconfigure=1 lets the
  // master super-admin sign back in (Supabase) to update providers.
  const isSetupReconfigure =
    pathname === '/admin/setup' && request.nextUrl.searchParams.get('reconfigure') === '1';

  // Paths that must stay reachable BEFORE any credentials exist (the bootstrap
  // surface). Declared once here so both admin-path blocks below share them.
  const isSetupPath =
    pathname === '/admin/setup' ||
    pathname.startsWith('/admin/setup') ||
    pathname === '/api/admin/setup' ||
    pathname.startsWith('/api/admin/setup');
  // NOTE: despite the name (kept to avoid touching every call site below),
  // this also covers /api/admin/impersonate — the Staff Impersonation
  // sign-in. Both are credential-establishing login endpoints that must be
  // reachable with NO prior admin session at all (a sales rep has never
  // touched this store's /admin before), same as /admin/login.
  const isSuperLoginPath =
    pathname === '/api/admin/super-login' ||
    pathname.startsWith('/api/admin/super-login/') ||
    pathname === '/api/admin/impersonate' ||
    pathname.startsWith('/api/admin/impersonate/');

  // Setup paths (page + API) are only reachable WITHOUT credentials while the
  // install is NOT ready — the readiness gate below short-circuits them before
  // the auth gates run. Once a store is configured, /admin/setup is treated like
  // any other admin path: it requires a valid admin credential (Basic Auth,
  // login session, or a verified device). `isSetupReconfigure` is still consulted
  // by the "ready" redirect above so the reconfigure entry point reaches the
  // route's own auth guard instead of being silently bounced to /admin.

  // The in-site login forms (pages + the shared API) must stay reachable before
  // ANY auth exists — they replace the native Basic-Auth dialog. All three
  // realms' pages count, or the realm whose page is not listed here would be
  // redirected to itself forever.
  const isLoginPath =
    isStaffLoginPath(pathname) ||
    pathname === '/api/admin/login' ||
    pathname.startsWith('/api/admin/login');

  if (isAdminPath || isSalesPath) {
    // Deprecated: /admin/setup-status was folded into the unified /admin/setup
    // dashboard. Redirect direct traffic (page or API) so old bookmarks and any
    // stale SETUP_REQUIRED deep-links still land somewhere useful.
    if (pathname.startsWith('/admin/setup-status')) {
      const url = request.nextUrl.clone();
      url.pathname = '/admin/setup';
      url.search = '';
      return NextResponse.redirect(url);
    }
    if (pathname.startsWith('/api/admin/setup-status')) {
      const url = request.nextUrl.clone();
      url.pathname = '/api/admin/setup';
      url.search = '';
      return NextResponse.redirect(url);
    }

    // ── Readiness gate (environment + bindings + admin account) ──────────────
    // The admin portal is intercepted while the install is NOT ready: either the
    // data store is missing or no admin account exists yet (no Basic Auth
    // password AND no Supabase super-admin). The setup checklist, provider
    // wizard and super-login endpoints stay OPEN so the operator can bootstrap
    // with no credentials. The in-site login page + API must also stay reachable
    // pre-config: it is the replacement for the native Basic-Auth dialog, and the
    // ONLY way in when ADMIN_BASIC_AUTH_PASSWORD is unset and the operator signs
    // in via the Supabase master account. See lib/env-discovery.ts →
    // computeAdminReady().
    // Storage readiness is per-driver (ANY ONE of Supabase / Cloudflare / Redis)
    // — no single backend is mandatory. See lib/env-discovery.ts.
    const storage = detectStorageDrivers();
    const legacyAdminOk = Boolean(resolveAdminPassword());

    let platformConfigured: boolean | null = null;
    if (supabaseEnvReady()) {
      try {
        platformConfigured = await isPlatformConfiguredEdge();
      } catch {
        platformConfigured = null;
      }
    }

    const ready = computeAdminReady({ storage, legacyAdminOk, platformConfigured });

    if (!ready) {
      if (isSetupPath || isSuperLoginPath || isLoginPath) {
        return NextResponse.next(); // bootstrap + in-site login endpoints are open pre-config
      }
      if (pathname.startsWith('/api/admin')) {
        return NextResponse.json(
          { error: 'SETUP_REQUIRED', redirect: '/admin/setup' },
          { status: 423, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = '/admin/setup';
      url.search = '';
      return NextResponse.redirect(url, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Ready: the provider wizard is no longer shown (except ?reconfigure=1).
    if (platformConfigured === true && isSetupPath && !pathname.startsWith('/api/admin') && !isSetupReconfigure) {
      const url = request.nextUrl.clone();
      url.pathname = '/admin';
      url.search = '';
      return NextResponse.redirect(url, { headers: { 'Cache-Control': 'no-store' } });
    }
  }

  if (isAdminPath || isSalesPath) {
    // A valid SUPER-ADMIN session — issued by /api/admin/super-login after a
    // Supabase master-account sign-in — authorizes the portal WITHOUT the env
    // Basic-Auth password or the email 2FA step (the master account IS the
    // credential). Resolved once here so the gates below can reuse it.
    const deviceToken = adminDeviceTokenFromRequest(request);
    const storage = createStorageClient();
    let superAdminOk = false;
    let authCookieOk = false;
    let deviceCookieValid = false;
    const authHeader = request.headers.get('authorization');
    const authCookieToken = adminAuthTokenFromRequest(request);
    if (storage) {
      try {
        superAdminOk = await adminDeviceIsSuperAdmin(storage, deviceToken);
        if (authCookieToken) authCookieOk = (await adminAuthValid(storage, authCookieToken)) !== null;
        if (deviceToken) deviceCookieValid = await adminDeviceValid(storage, deviceToken);
      } catch {
        /* fail closed */
      }
    }

    // No Basic-Auth password configured: the operator can ONLY reach /admin via
    // the in-site login form. Any recognized credential (super-admin session,
    // login-session cookie, or a verified device cookie) must be allowed past
    // this guard — otherwise the login → 2FA verify flow 401s with AUTH_REQUIRED
    // before the verify routes' own auth guard (adminLoginAuthorized) can run.
    if (
      !superAdminOk &&
      !authCookieOk &&
      !deviceCookieValid &&
      !isLoginPath &&
      !isSuperLoginPath &&
      !ADMIN_PASSWORD
    ) {
      return adminAuthRequired(request, portal);
    }

    // Gate 1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â HTTP Basic Auth on EVERY admin path (page + all APIs). There is
    // no password-in-query bypass anymore: the audit / export / self-test
    // routes used to be reachable with `?password=ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`, which leaks the password
    // into server logs, browser history and Referer headers.
    // A request that actually PRESENTS a Basic-Auth header is rate-limited
    // before it's compared — this is the credential check every other
    // admin-password check sits behind, so it's the one place a single
    // limiter closes the brute-force gap for the whole portal at once.
    if (authHeader && !superAdminOk && !authCookieOk && !deviceCookieValid) {
      if (await basicAuthRateLimited(storage, request)) {
        return NextResponse.json(
          { error: 'Too many sign-in attempts. Try again shortly.' },
          { status: 429, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }
    const passwordPassed =
      superAdminOk ||
      isLoginPath ||
      isSuperLoginPath ||
      verifyBasicAuth(authHeader) ||
      authCookieOk ||
      deviceCookieValid;
    if (!passwordPassed) {
      return adminAuthRequired(request, portal);
    }

    // Gate 2 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â two-step email verification. The /admin page itself and the
    // verify-* endpoints are exempt so the operator can reach the 2FA screen;
    // everything else requires a valid device cookie from a verified browser.
    const isPage =
      pathname === '/admin' ||
      pathname === '/admin/' ||
      pathname === '/sales' ||
      pathname === '/sales/';
    const isVerifyEndpoint = TWO_FA_EXEMPT.some((p) => pathname === p);
    if (!isPage && !isVerifyEndpoint && !isLoginPath && !superAdminOk && !isSuperLoginPath) {
      const token = adminDeviceTokenFromRequest(request);
      const redis = createStorageClient();
      let verified = false;
      if (redis) {
        try {
          verified = await adminDeviceValid(redis, token);
        } catch {
          verified = false;
        }
      } else {
        // No storage configured ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â nothing to protect, never lock the portal.
        verified = true;
      }
      if (!verified) {
        return new NextResponse(JSON.stringify({ error: 'ADMIN_2FA_REQUIRED' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
  }

  // ── LICENSE GATE (sync MISSING-key Demo Mode) ─────────────────────────────
  // When licensing is enforced and no key is present, public write routes are
  // blocked. Admin/auth/Stripe-webhook paths stay reachable so the operator can
  // still sign in and fix the key. (Full ACTIVE/GRACE/EXPIRED classification is
  // async and happens route-side via lib/license.ts + /api/admin/license.)
  if (licenseEnforced() && !resolveLicenseKey()) {
    const method = request.method.toUpperCase();
    const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    const isExempt =
      pathname.startsWith('/api/admin') ||
      pathname.startsWith('/api/auth') ||
      pathname.startsWith('/api/stripe') ||
      pathname.startsWith('/api/ai');
    if (isWrite && pathname.startsWith('/api/') && !isExempt) {
      return NextResponse.json(
        { error: 'DEMO_MODE', message: 'Writes are disabled until a valid license key is configured.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  // ── PRODUCTION ENV GUARDRAIL (malformed secrets, not missing ones) ───────
  // Same shape as the license gate above: a malformed production secret
  // (truncated key, wrong value pasted into the wrong field, a literal
  // "your-key-here" placeholder left in .env) blocks WRITES only — reads and
  // the admin/auth/stripe/cron paths stay reachable so the operator can
  // still sign in and fix the value. See lib/env-schema.ts for exactly what
  // counts as malformed (format only — a MISSING value is this template's
  // normal "not configured yet, use the Setup Wizard" state and is never
  // flagged here).
  {
    const method = request.method.toUpperCase();
    const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
    // Cheap checks first (method, path) — productionEnvHasBlockingIssues()
    // runs a Zod parse over process.env and previously ran unconditionally
    // on EVERY request (including every GET/static-adjacent request) in
    // production; it only matters for writes, so gate on that first.
    if (isWrite && pathname.startsWith('/api/') && process.env.NODE_ENV === 'production' && productionEnvHasBlockingIssues()) {
      const isExempt =
        pathname.startsWith('/api/admin') ||
        pathname.startsWith('/api/auth') ||
        pathname.startsWith('/api/stripe') ||
        pathname.startsWith('/api/cron') ||
        pathname.startsWith('/api/checkout/cron-draw');
      if (!isExempt) {
        return NextResponse.json(
          {
            error: 'ENV_MISCONFIGURED',
            message: 'A production environment variable is malformed. Check /admin → Environment Status and fix it before writes can resume.',
          },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }
  }

  // ── MAINTENANCE MODE (unauthenticated visitors) ───────────────────────────
  // When MAINTENANCE_MODE is on, page requests redirect to /maintenance unless
  // the visitor is a signed-in admin (an authenticated admin can view the
  // public site normally). API routes + static assets stay reachable.
  //
  // This used to check ONLY raw Basic Auth, which is unreachable by normal
  // browser navigation for the two other fully-supported sign-in paths: the
  // in-site /admin/login form + emailed 2FA device cookie, and the Supabase
  // super-admin session. An operator who set up the store WITHOUT
  // ADMIN_BASIC_AUTH_PASSWORD (a supported config — see resolveAdminPassword)
  // had literally no way to preview the live site during maintenance.
  if (maintenanceModeEnabled()) {
    const isApi = pathname.startsWith('/api/');
    if (!isApi && !isMaintenanceExemptPath(pathname)) {
      let authed = verifyBasicAuth(request.headers.get('authorization'));
      if (!authed) {
        const deviceToken = adminDeviceTokenFromRequest(request);
        const authToken = adminAuthTokenFromRequest(request);
        if (deviceToken || authToken) {
          const redis = createStorageClient();
          if (redis) {
            try {
              authed =
                (Boolean(deviceToken) && (await adminDeviceValid(redis, deviceToken))) ||
                (Boolean(authToken) && Boolean(await adminAuthValid(redis, authToken)));
            } catch {
              authed = false;
            }
          }
        }
      }
      if (!authed) {
        const url = request.nextUrl.clone();
        url.pathname = '/maintenance';
        url.search = '';
        return NextResponse.redirect(url);
      }
    }
  }

  // Pass the pathname through to Server Components (app/admin/layout.tsx's
  // zero-trust portal RBAC needs it to exempt /admin/login and /admin/setup
  // from the "no session → redirect to /admin/login" check — otherwise that
  // check would redirect the login page to itself, an infinite loop). A
  // Server Component layout has no direct access to the request path, so
  // this is the standard way to thread it through.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set('x-pathname', effectivePathname);
  if (portalRewriteTarget) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = portalRewriteTarget;
    return NextResponse.rewrite(rewriteUrl, { request: { headers: forwardedHeaders } });
  }
  return NextResponse.next({ request: { headers: forwardedHeaders } });
}

export const config = {
  // The middleware now ALSO enforces the license gate + maintenance mode on
  // public routes, so it must run beyond just /admin. It skips Next.js
  // internals, media, and common static-file extensions served straight out
  // of `public/` (images, fonts, icons, well-known files) to stay cheap —
  // none of those paths are ever `/admin`/`/sales`/a write API, so running
  // CSRF/portal/license/env checks against them was pure overhead.
  matcher: [
    '/((?!_next/|media/|\\.well-known/|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|css|js|map|woff|woff2|ttf|eot|txt|xml|json)$).*)',
  ],
};
