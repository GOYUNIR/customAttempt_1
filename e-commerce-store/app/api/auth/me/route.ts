import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY, sessionKey } from '@/lib/server-config';

export const dynamic = 'force-dynamic';

/**
 * A stable, non-500 response for when the data store or auth environment is
 * missing/uninitialized. The React client treats this exactly like "signed
 * out" (`user: null`) and never retries/re-renders in a loop because the
 * response is a clean 200 — no thrown error to re-enter a callback stack.
 */
function unconfiguredResponse() {
  return NextResponse.json(
    { authenticated: false, reason: 'unconfigured_environment', user: null },
    { status: 200 },
  );
}

export async function GET(request: Request) {
  try {
    const cookie = request.headers.get('cookie');
    if (!cookie) {
      return NextResponse.json({ user: null });
    }

    // Parse cookies manually
    const cookiePairs = cookie.split(';').map(c => c.trim().split('='));
    const cookieMap: Record<string, string> = {};
    for (const [key, value] of cookiePairs) {
      cookieMap[key] = value;
    }
    const token = cookieMap['goyunir_session'];

    if (!token) {
      return NextResponse.json({ user: null });
    }

    const redis = createRedisClient();
    if (!redis) {
      return unconfiguredResponse();
    }

    const sessionKeyName = sessionKey(token);
    const sessionData = await redis.get(sessionKeyName);
    if (!sessionData) {
      return NextResponse.json({ user: null });
    }

    const session = safeParseRedisItem<any>(sessionData);
    if (!session || Date.now() > session.expiresAt) {
      await redis.del(sessionKeyName);
      return NextResponse.json({ user: null });
    }

    // Pull the live user record so rewards/credits shown in /account are fresh
    // even when the admin adjusts points from /admin → Users.
    let rewards = Number(session.rewards || 0);
    let welcomePromoCode: string | null = null;
    let emailVerified = session.emailVerified === true;
    if (session.userId) {
      try {
        const rawUser = await redis.hget(USERS_KEY, session.userId);
        const user = safeParseRedisItem<any>(rawUser);
        if (user) {
          rewards = Number(user.rewards ?? rewards) || 0;
          welcomePromoCode = typeof user.welcomePromoCode === 'string' ? user.welcomePromoCode : null;
          // Accounts created before email verification existed count as verified.
          emailVerified = user.emailVerified !== false;
        }
      } catch {}
    }

    return NextResponse.json({
      user: {
        id: session.userId,
        email: session.email,
        role: session.role,
        rewards,
        welcomePromoCode,
        emailVerified,
      },
    });
  } catch (err) {
    // Defensive: a storage/auth failure must NEVER surface as an unhandled 500
    // (the reported bug). Fail closed to "signed out" with an explicit reason.
    console.error('[auth/me] fallback', err instanceof Error ? err.message : err);
    return unconfiguredResponse();
  }
}
