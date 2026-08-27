import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createStorageClient } from '@/lib/storage';
import { ADMIN_DEVICES_KEY, ADMIN_AUTH_PREFIX } from '@/lib/redis-keys';
import { isPlatformConfiguredEdge, supabaseEnvReady } from '@/services/config/edge';
import { computeAdminReady, detectStorageDrivers } from '@/lib/env-discovery';
import { licenseEnforced, resolveLicenseKey } from '@/lib/license';
import { maintenanceModeEnabled, isMaintenanceExemptPath } from '@/lib/maintenance';


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
/**
 * Edge-safe minimal JSON parse for Redis values. Mirrors
 * `safeParseRedisItem()` in lib/server-config.ts ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Upstash REST Redis
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

/** The in-site /admin/login form + its API replace the native Basic-Auth dialog. */
function adminAuthRequired(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/admin')) {
    return NextResponse.json(
      { error: 'AUTH_REQUIRED', redirect: '/admin/login' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = '/admin/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {

  const pathname = request.nextUrl.pathname;
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
  const isSuperLoginPath =
    pathname === '/api/admin/super-login' ||
    pathname.startsWith('/api/admin/super-login/');

  // The setup wizard's STATUS read (GET) must stay reachable even AFTER the
  // platform is configured, so the reconfigure page can detect `configured`
  // and render the "sign in as super-admin" panel. POST stays fully gated by
  // the route's own guard (Basic Auth or a super-admin session) — this only
  // opens the read-only status probe, never a write path.
  const isSetupRead = isSetupPath && request.method.toUpperCase() === 'GET';

  // The setup API (GET + POST) must reach the route's OWN auth guard — the
  // route re-checks Basic Auth, a super-admin session AND proof of the Supabase
  // service-role key (the master write credential). The middleware's Basic-Auth
  // gate below otherwise blocks the reconfigure SAVE before the route's
  // service-role fallback can run — the exact "Sign in first" deadlock on an
  // already-configured store.
  const isSetupApi =
    pathname === '/api/admin/setup' || pathname.startsWith('/api/admin/setup');

  // The in-site login form (page + API) must stay reachable before ANY auth
  // exists — it is the replacement for the native Basic-Auth dialog.
  const isLoginPath =
    pathname === '/admin/login' ||
    pathname.startsWith('/admin/login') ||
    pathname === '/api/admin/login' ||
    pathname.startsWith('/api/admin/login');

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
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
      return NextResponse.redirect(url);
    }

    // Ready: the provider wizard is no longer shown (except ?reconfigure=1).
    if (platformConfigured === true && isSetupPath && !pathname.startsWith('/api/admin') && !isSetupReconfigure) {
      const url = request.nextUrl.clone();
      url.pathname = '/admin';
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
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
      !isSetupReconfigure &&
      !isSetupRead &&
      !isSetupApi &&
      !ADMIN_PASSWORD
    ) {
      return adminAuthRequired(request);
    }

    // Gate 1 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â HTTP Basic Auth on EVERY admin path (page + all APIs). There is
    // no password-in-query bypass anymore: the audit / export / self-test
    // routes used to be reachable with `?password=ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦`, which leaks the password
    // into server logs, browser history and Referer headers.
    const passwordPassed =
      superAdminOk ||
      isLoginPath ||
      isSuperLoginPath ||
      isSetupReconfigure ||
      isSetupRead ||
      isSetupApi ||
      verifyBasicAuth(authHeader) ||
      authCookieOk ||
      deviceCookieValid;
    if (!passwordPassed) {
      return adminAuthRequired(request);
    }

    // Gate 2 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â two-step email verification. The /admin page itself and the
    // verify-* endpoints are exempt so the operator can reach the 2FA screen;
    // everything else requires a valid device cookie from a verified browser.
    const isPage =
      pathname === '/admin' ||
      pathname === '/admin/';
    const isVerifyEndpoint = TWO_FA_EXEMPT.some((p) => pathname === p);
    if (!isPage && !isVerifyEndpoint && !isLoginPath && !superAdminOk && !isSuperLoginPath && !isSetupReconfigure && !isSetupRead && !isSetupApi) {
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

  // ── MAINTENANCE MODE (unauthenticated visitors) ───────────────────────────
  // When MAINTENANCE_MODE is on, page requests redirect to /maintenance unless
  // the visitor carries valid admin Basic Auth (an authenticated admin can view
  // the public site normally). API routes + static assets stay reachable.
  if (maintenanceModeEnabled()) {
    const isApi = pathname.startsWith('/api/');
    if (!isApi && !isMaintenanceExemptPath(pathname)) {
      const authed = verifyBasicAuth(request.headers.get('authorization'));
      if (!authed) {
        const url = request.nextUrl.clone();
        url.pathname = '/maintenance';
        url.search = '';
        return NextResponse.redirect(url);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  // The middleware now ALSO enforces the license gate + maintenance mode on
  // public routes, so it must run beyond just /admin. It skips Next.js
  // internals, media and static assets to stay cheap.
  matcher: ['/((?!_next/|media/|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)'],
};
