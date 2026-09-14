/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CSRF — pure decision engine for Origin/Referer verification.
 *
 * Every session in this app (customer, admin device, admin login-session) is
 * a cookie, and the write routes had no CSRF defense beyond `SameSite=Lax` —
 * real, but fragile (browser extensions, a future `sameSite: 'none'`, or a
 * same-site XSS pivot all bypass it). Rather than plumb a synchronized CSRF
 * token through every fetch() call in the admin portal and storefront (a
 * huge, hard-to-verify blast radius), this enforces the standard
 * OWASP-recommended alternative: a state-changing request that carries one
 * of our auth cookies MUST also carry an Origin (or Referer) header naming
 * THIS host. A cross-site page can trick a browser into sending the cookie,
 * but it cannot control what Origin the browser reports — that header is
 * not forgeable from HTML/JS.
 *
 * Deliberately scoped to requests that actually carry a first-party auth
 * cookie: a request with none of them is either unauthenticated or using a
 * non-cookie credential (Basic-Auth header, a body-supplied admin password,
 * a cron/webhook secret) — none of those are auto-attached by a browser, so
 * none of them are CSRF-exploitable regardless of Origin.
 *
 * ZERO imports (mirrors lib/lockdown.ts / lib/rbac.ts) so this loads in the
 * Edge middleware runtime AND under `node --test` with no adapter needed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const CSRF_AUTH_COOKIES = ['goyunir_session', 'goyunir_admin_device', 'goyunir_admin_auth'];
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Server-to-server / externally-signed endpoints that must stay reachable
 *  with no Origin header at all (Stripe never sends one; cron callers are
 *  plain HTTP clients) — both already authenticate via a signature/secret,
 *  not a cookie, so they would be exempted by the cookie check anyway;
 *  listed explicitly for clarity and as defense-in-depth. */
export const CSRF_EXEMPT_PREFIXES = ['/api/stripe/webhook', '/api/cron/', '/api/checkout/cron-draw'];

export interface CsrfCheckInput {
  method: string;
  pathname: string;
  /** Raw `Cookie` request header, or '' when absent. */
  cookieHeader: string;
  /** `Origin` request header, or null when absent. */
  origin: string | null;
  /** `Referer` request header, or null when absent. */
  referer: string | null;
  /** The host this request was addressed to (`request.nextUrl.host` /
   *  `Host` header) — what Origin/Referer must match. */
  requestHost: string;
}

function hasAuthCookie(cookieHeader: string): boolean {
  return CSRF_AUTH_COOKIES.some((name) => new RegExp(`(?:^|;\\s*)${name}=`).test(cookieHeader));
}

function hostOf(urlLike: string): string {
  try {
    return new URL(urlLike).host;
  } catch {
    return '';
  }
}

/** True when this request must be BLOCKED as a cross-site write. */
export function isCsrfBlocked(input: CsrfCheckInput): boolean {
  const method = input.method.toUpperCase();
  if (CSRF_SAFE_METHODS.has(method)) return false;
  if (CSRF_EXEMPT_PREFIXES.some((p) => input.pathname.startsWith(p))) return false;
  if (!hasAuthCookie(input.cookieHeader)) return false;

  const candidate = input.origin || input.referer;
  if (!candidate) return true; // cookie-bearing write with NEITHER header — block
  const candidateHost = hostOf(candidate);
  if (!candidateHost) return true; // unparsable Origin/Referer — block
  return candidateHost !== input.requestHost;
}
