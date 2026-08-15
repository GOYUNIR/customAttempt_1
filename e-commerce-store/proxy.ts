import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminPassword, createRedisClient } from '@/lib/server-config';
import { isAdminDeviceValid, adminDeviceTokenFromRequest } from '@/lib/admin-verify';

const ADMIN_USER = process.env.ADMIN_BASIC_AUTH_USERNAME || 'admin';
const ADMIN_PASSWORD = getAdminPassword();

/**
 * Constant-time string comparison that works in the proxy (Edge) runtime where
 * Node's crypto.timingSafeEqual is unavailable. Length is compared first (the
 * same information timingSafeEqual leaks), then every byte is XORed together so
 * a timing attacker can never learn the password one character at a time.
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
  return timingSafeStringEq(user, ADMIN_USER) && timingSafeStringEq(pass, ADMIN_PASSWORD);
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!ADMIN_USER || !ADMIN_PASSWORD) {
      return new NextResponse('Admin not configured', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin Portal"' },
      });
    }

    // Gate 1 — HTTP Basic Auth on EVERY admin path (page + all APIs). There is
    // no password-in-query bypass anymore: the audit / export / self-test
    // routes used to be reachable with `?password=…`, which leaks the password
    // into server logs, browser history and Referer headers.
    const authHeader = request.headers.get('authorization');
    if (!verifyBasicAuth(authHeader)) {
      return new NextResponse('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin Portal"' },
      });
    }

    // Gate 2 — two-step email verification. The /admin page itself and the
    // verify-* endpoints are exempt so the operator can reach the 2FA screen;
    // everything else requires a valid device cookie from a verified browser.
    const isPage = pathname === '/admin' || pathname === '/admin/';
    const isVerifyEndpoint = TWO_FA_EXEMPT.some((p) => pathname === p);
    if (!isPage && !isVerifyEndpoint) {
      const token = adminDeviceTokenFromRequest(request);
      const redis = createRedisClient();
      let verified = false;
      if (redis) {
        try {
          verified = await isAdminDeviceValid(redis, token);
        } catch {
          verified = false;
        }
      } else {
        // No Redis configured — nothing to protect, never lock the portal.
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

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};