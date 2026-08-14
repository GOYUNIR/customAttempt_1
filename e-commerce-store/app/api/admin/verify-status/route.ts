import { NextResponse } from 'next/server';
import { createRedisClient, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { isAdminDeviceValid, adminDeviceTokenFromRequest } from '@/lib/admin-verify';

export const dynamic = 'force-dynamic';

/** Whether this browser already passed two-step admin verification. */
export async function GET(request: Request) {
  try {
    const token = adminDeviceTokenFromRequest(request);
    if (!token) {
      return NextResponse.json({ verified: false, remember: false });
    }
    const redis = createRedisClient();
    if (!redis) {
      // No Redis configured (fresh dev box) — there is no state to protect, so
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
