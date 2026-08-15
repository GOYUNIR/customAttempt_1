import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY } from '@/lib/server-config';
import { issueCustomerVerifyCode } from '@/lib/customer-verify';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** Resend the signup verification code (throttled to one per 60 seconds). */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return NextResponse.json({ error: 'Email required.' }, { status: 400 });

    const limited = await rateLimitedResponse('auth_resend_verification', request, 10, 60);
    if (limited) return limited;

    const redis = createRedisClient();
    if (!redis) return NextResponse.json({ error: 'System error' }, { status: 500 });

    // Only unverified accounts can request a code.
    const raw = await redis.hgetall(USERS_KEY);
    let user: any = null;
    if (raw) {
      for (const [, v] of Object.entries(raw)) {
        const u = safeParseRedisItem<any>(v);
        if (u && String(u.email || '').toLowerCase() === email) { user = u; break; }
      }
    }
    if (!user) {
      return NextResponse.json({ error: 'No account found for that email.' }, { status: 404 });
    }
    if (user.emailVerified === true) {
      return NextResponse.json({ error: 'This email is already verified — just log in.' }, { status: 400 });
    }

    const result = await issueCustomerVerifyCode(redis, email);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Could not send the code.' }, { status: result.throttled ? 429 : 500 });
    }
    return NextResponse.json({ ok: true, devCode: result.devCode });
  } catch {
    return NextResponse.json({ error: 'Failed to resend the code.' }, { status: 500 });
  }
}
