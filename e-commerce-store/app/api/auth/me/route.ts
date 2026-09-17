import { NextResponse } from 'next/server';
import { createKvClient, safeParseKvItem, USERS_KEY, sessionKey } from '@/lib/server-config';
import { readProfile } from '@/lib/customer-profile';
import { ensureDefaultTenant } from '@/lib/tenant-context';

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

    const redis = createKvClient();
    if (!redis) {
      return unconfiguredResponse();
    }

    const sessionKeyName = sessionKey(token);
    const sessionData = await redis.get(sessionKeyName);
    if (!sessionData) {
      return NextResponse.json({ user: null });
    }

    const session = safeParseKvItem<any>(sessionData);
    if (!session || Date.now() > session.expiresAt) {
      await redis.del(sessionKeyName);
      return NextResponse.json({ user: null });
    }

    // The session is a SNAPSHOT taken at login; /account re-reads through here
    // so the points shown are live.
    //
    // H7 split where each field comes from. The balance and the role are read
    // from public.customers (authoritative, migration 00022). welcomePromoCode
    // and emailVerified still come from the KV record: verification is auth,
    // which stayed in KV on purpose (DEFERRED-6), and the welcome promo code is
    // promo bookkeeping that 00022 did not move.
    let rewards = Number(session.rewards || 0);
    let role = session.role;
    let welcomePromoCode: string | null = null;
    let emailVerified = session.emailVerified === true;

    try {
      const tenantId = await ensureDefaultTenant();
      const profile = await readProfile(tenantId, String(session.email || ''));
      if (profile) {
        rewards = profile.rewardsBalance;
        role = profile.role;
      } else {
        // No customer record means nothing has ever been granted to this
        // address. Say zero rather than repeating a stale session number.
        rewards = 0;
      }
    } catch (profileErr) {
      console.error('[auth/me] profile read failed', profileErr instanceof Error ? profileErr.message : profileErr);
    }

    if (session.userId) {
      try {
        const rawUser = await redis.hget(USERS_KEY, session.userId);
        const user = safeParseKvItem<any>(rawUser);
        if (user) {
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
        role,
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
