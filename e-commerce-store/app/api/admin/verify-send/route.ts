import { NextResponse } from 'next/server';
import { createRedisClient, getAdminVerifyEmail, adminRequestAuthorized } from '@/lib/server-config';
import { issueAdminCode } from '@/lib/admin-verify';

export const dynamic = 'force-dynamic';

/** Resend the admin sign-in code (throttled to once per 60 seconds per inbox). */
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

    const result = await issueAdminCode(redis, adminEmail);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Could not resend the code.' }, { status: result.throttled ? 429 : 500 });
    }
    return NextResponse.json({ ok: true, devCode: result.devCode });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to resend code' }, { status: 500 });
  }
}
