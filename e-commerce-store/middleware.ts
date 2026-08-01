import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ADMIN_USER = process.env.ADMIN_BASIC_AUTH_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_BASIC_AUTH_PASSWORD;

function unauthorizedResponse() {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Admin Portal"' },
  });
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
  const [user, pass] = decoded.split(':');
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!ADMIN_USER || !ADMIN_PASSWORD || !verifyBasicAuth(request.headers.get('authorization'))) {
      return unauthorizedResponse();
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};