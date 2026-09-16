import { NextResponse } from 'next/server';
import { createKvClient } from '@/lib/server-config';
import { issueAdminCode, adminLoginAuthorized, resolveAdminLoginEmail } from '@/lib/admin-verify';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Resend the admin sign-in code (throttled to once per 60 seconds per inbox,
 *  PLUS a per-IP limiter here — this route re-checks the admin password too,
 *  same as verify-start, and needs the same brute-force protection). */
export async function POST(request: Request) {
  try {
    const limited = await rateLimitedResponse('admin_verify_send', request, 10, 60);
    if (limited) return limited;

    const body = await request.json().catch(() => ({}));
    const password = String(body?.password || '');
    if (!(await adminLoginAuthorized(request, password))) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
    }

    const adminEmail = await resolveAdminLoginEmail(request);
    if (!adminEmail) {
      return NextResponse.json({ error: 'No admin verification inbox configured.' }, { status: 400 });
    }

    const redis = createKvClient();
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
