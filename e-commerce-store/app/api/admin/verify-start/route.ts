import { NextResponse } from 'next/server';
import { createRedisClient } from '@/lib/server-config';
import { issueAdminCode, adminLoginAuthorized, resolveAdminLoginEmail } from '@/lib/admin-verify';

export const dynamic = 'force-dynamic';

/**
 * Step 1 of admin two-step sign-in: the operator has already passed either
 * Basic Auth or the in-site login form (/admin/login), and this endpoint
 * re-verifies that, then emails a 6-digit code to the verified admin email.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const password = String(body?.password || '');
    if (!(await adminLoginAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const adminEmail = await resolveAdminLoginEmail(request);
    if (!adminEmail) {
      return NextResponse.json({
        error: 'No admin verification inbox configured. Set ADMIN_VERIFY_EMAIL (or SUPPORT_EMAIL) in the platform environment.',
      }, { status: 400 });
    }

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'Redis offline' }, { status: 500 });

    const result = await issueAdminCode(redis, adminEmail);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Could not send the code.' }, { status: result.throttled ? 429 : 500 });
    }

    return NextResponse.json({
      ok: true,
      sentTo: adminEmail,
      // Only ever exposed outside production so local development can proceed
      // without a configured email provider.
      devCode: result.devCode,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to start verification' }, { status: 500 });
  }
}
