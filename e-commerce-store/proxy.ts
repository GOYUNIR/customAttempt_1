import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAdminPassword } from '@/lib/server-config';

const ADMIN_USER = process.env.ADMIN_BASIC_AUTH_USERNAME || 'admin';
const ADMIN_PASSWORD = getAdminPassword();

const PASSWORD_GATE_ONLY = [
  '/api/admin/self-test',
  '/api/admin/selftest',
  '/api/admin/audit',
  '/api/admin/export-winners',
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
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (PASSWORD_GATE_ONLY.some((item) => pathname === item || pathname.startsWith(item + '/'))) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!ADMIN_USER || !ADMIN_PASSWORD) {
      return new NextResponse('Admin not configured', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin Portal"' },
      });
    }

    const authHeader = request.headers.get('authorization');
    if (!verifyBasicAuth(authHeader)) {
      return new NextResponse('Authentication required', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Admin Portal"' },
      });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};