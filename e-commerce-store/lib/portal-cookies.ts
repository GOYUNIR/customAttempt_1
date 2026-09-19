/**
 * PORTAL COOKIES — thin Next.js glue over lib/edge-router.ts's pure
 * `cookieDomainForPortal`, for the admin/sales session cookie-setters
 * (app/api/admin/login, super-login, impersonate, verify-confirm, setup).
 *
 * Kept separate from lib/edge-router.ts so that file stays zero-import and
 * `node --test`-loadable — this one needs `next/server`'s `ResponseCookie`
 * shape, which only resolves through the Next.js bundler.
 */

import { cookieDomainForPortal, classifyHost, resolveRequestHost, type Portal } from './edge-router';

export type PortalCookieAttrs = {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
  domain?: string;
};

/** Build the `response.cookies.set(name, value, attrs)` third argument for
 *  an admin/sales session cookie. `request` supplies the Host header used to
 *  resolve `PLATFORM_ROOT_DOMAIN` classification consistently with
 *  middleware.ts; when that env var is unset (the common case today), the
 *  returned `domain` is `undefined` — the cookie stays host-only, exactly
 *  today's behavior. */
/**
 * The portal a request actually arrived on, from its Host header.
 *
 * THE BUG THIS EXISTS TO FIX. Every caller of `portalCookieAttrs` in
 * app/api/admin/{login,verify-confirm}/route.ts hardcoded the literal string
 * `'admin'`, regardless of which staff host the sign-in was actually happening
 * on. `cookieDomainForPortal('admin', root)` scopes the cookie to
 * `admin.<root>` — a Set-Cookie with that Domain, returned from a response to
 * `app.<root>` or `sales.<root>`, is not a domain a browser will accept for
 * that host (RFC 6265: Domain must equal the current host or a parent of it;
 * a sibling subdomain is neither). The browser silently drops the cookie —
 * no error, nothing in the network tab looks wrong — and the operator is
 * bounced straight back to the login page they just successfully signed in
 * on, forever, because no session cookie ever actually got stored.
 *
 * Uses the SAME host-resolution and classification middleware.ts uses, so a
 * cookie set here and a cookie read there always agree on which portal a
 * request belongs to.
 */
export function requestPortal(request: Request): Portal {
  const host = resolveRequestHost(
    { xForwardedHost: request.headers.get('x-forwarded-host'), host: request.headers.get('host') },
    '',
  );
  return classifyHost(host, process.env.PLATFORM_ROOT_DOMAIN || undefined);
}

export function portalCookieAttrs(request: Request, portal: Portal, maxAgeSeconds: number): PortalCookieAttrs {
  const rootDomain = process.env.PLATFORM_ROOT_DOMAIN || undefined;
  const domain = cookieDomainForPortal(portal, rootDomain);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
    ...(domain ? { domain } : {}),
  };
}
