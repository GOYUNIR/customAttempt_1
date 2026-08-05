import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ADMIN_USER = process.env.ADMIN_BASIC_AUTH_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_BASIC_AUTH_PASSWORD;

/** Public-with-password routes under /api/admin (password checked in the route). */
const PASSWORD_GATE_ONLY = [
  '/api/admin/self-test',
  '/api/admin/selftest',
  '/api/admin/audit',
  '/api/admin/export-winners',
];

function unauthorizedResponse(request: NextRequest) {
  // Redirect to home page instead of showing auth prompt
  const url = new URL('/', request.url);
  return NextResponse.redirect(url);
}

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
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Allow password-gated API routes to handle auth themselves
  if (PASSWORD_GATE_ONLY.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  // Protect admin routes
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    // Check if credentials are configured
    if (!ADMIN_USER || !ADMIN_PASSWORD) {
      return unauthorizedResponse(request);
    }
    
    // Check for valid Basic Auth
    const authHeader = request.headers.get('authorization');
    if (!verifyBasicAuth(authHeader)) {
      return unauthorizedResponse(request);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};