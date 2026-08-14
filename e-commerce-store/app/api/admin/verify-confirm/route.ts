import { NextResponse } from 'next/server';
import { createRedisClient, getAdminVerifyEmail, adminRequestAuthorized, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { consumeAdminCode, issueAdminDevice } from '@/lib/admin-verify';

export const dynamic = 'force-dynamic';

/**
 * Step 2 of admin two-step sign-in: confirm the emailed one-time code. On
 * success an httpOnly device cookie is set (30 days when "remember device" is
 * checked, otherwise 24 hours). proxy.ts validates that cookie on every
 * subsequent /api/admin request.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const password = String(body?.password || '');
    if (!adminRequestAuthorized(request, password)) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const adminEmail = getAdminVerifyEmail();
    if (!adminEmail) {
      return NextResponse.json({ error: 'No admin verification inbox configured.' }, { status: 400 });
    }

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const code = String(body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Enter the 6-digit code from the email.' }, { status: 400 });
    }

    const result = await consumeAdminCode(redis, adminEmail, code);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Verification failed.' }, { status: 400 });
    }

    const remember = body?.remember === true;
    const { token, maxAgeSeconds } = await issueAdminDevice(redis, adminEmail, remember);

    const response = NextResponse.json({ ok: true, verified: true, remember });
    response.cookies.set(ADMIN_DEVICE_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: maxAgeSeconds,
      path: '/',
    });
    return response;
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Verification failed' }, { status: 500 });
  }
}
