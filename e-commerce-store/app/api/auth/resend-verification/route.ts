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
      // Throttle → 429 (retry later). A genuine send failure is a 502 (the
      // upstream email provider is unreachable), never a bare 500. The 429
      // carries `retryAfterSeconds` so the client can render an accurate
      // cooldown timer instead of a raw status code in the console.
      if (result.throttled) {
        return NextResponse.json(
          { error: result.error || 'Please wait before requesting another code.', retryAfterSeconds: result.retryAfterSeconds ?? 60 },
          { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds ?? 60) } },
        );
      }
      return NextResponse.json({ error: "We couldn't email the code right now. Please try again." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, devCode: result.devCode, retryAfterSeconds: 60 });
  } catch {
    return NextResponse.json({ error: 'Failed to resend the code.' }, { status: 500 });
  }
}
