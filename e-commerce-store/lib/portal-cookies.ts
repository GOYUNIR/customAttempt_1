/**
 * PORTAL COOKIES — thin Next.js glue over lib/edge-router.ts's pure
 * `cookieDomainForPortal`, for the admin/sales session cookie-setters
 * (app/api/admin/login, super-login, impersonate, verify-confirm, setup).
 *
 * Kept separate from lib/edge-router.ts so that file stays zero-import and
 * `node --test`-loadable — this one needs `next/server`'s `ResponseCookie`
 * shape, which only resolves through the Next.js bundler.
 */

import { cookieDomainForPortal, type Portal } from './edge-router';

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
