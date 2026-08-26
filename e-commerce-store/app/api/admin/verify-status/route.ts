import { NextResponse } from 'next/server';
import { createRedisClient, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { isAdminDeviceValid, adminDeviceTokenFromRequest, adminLoginAuthorized } from '@/lib/admin-verify';

export const dynamic = 'force-dynamic';

/**
 * Whether this browser already passed two-step admin verification.
 *
 * Defense-in-depth: the route itself re-validates admin authorization (Basic
 * Auth header / in-site login cookie / supplied password) on top of proxy.ts's
 * gate, so this handler can never leak verification state to an unauthenticated
 * caller.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!(await adminLoginAuthorized(request, password))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  try {
    const token = adminDeviceTokenFromRequest(request);
    if (!token) {
      return NextResponse.json({ verified: false, remember: false });
    }
    const redis = createRedisClient();
    if (!redis) {
      // No storage configured (fresh dev box) — there is no state to protect, so
      // don't hard-lock the portal behind a device cookie.
      return NextResponse.json({ verified: true, remember: false });
    }
    const valid = await isAdminDeviceValid(redis, token);
    if (!valid) {
      // Stale/revoked cookie — clear it so the operator is prompted to re-verify.
      const res = NextResponse.json({ verified: false, remember: false });
      res.cookies.set(ADMIN_DEVICE_COOKIE, '', { maxAge: 0, path: '/' });
      return res;
    }
    return NextResponse.json({ verified: true, remember: true });
  } catch (err: any) {
    return NextResponse.json({ verified: false, remember: false, error: err?.message });
  }
}
