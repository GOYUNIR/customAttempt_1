import { NextResponse } from 'next/server';
import { createKvClient, safeParseKvItem, USERS_KEY } from '@/lib/server-config';
import { consumeCustomerVerifyCode } from '@/lib/customer-verify';
import {
  grantWelcomeRewards,
  createCustomerSession,
  trySendWelcomeEmail,
  CUSTOMER_SESSION_TTL_SECONDS,
} from '@/lib/customer-rewards';
import { isValidEmail } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { readProfile } from '@/lib/customer-profile';
import { ensureDefaultTenant } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

function createSessionCookie(response: NextResponse, token: string) {
  response.cookies.set('goyunir_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: CUSTOMER_SESSION_TTL_SECONDS,
    path: '/',
  });
}

/** Confirm the emailed code, then unlock the account + welcome rewards + session. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body?.email || '').trim().toLowerCase();
    const code = String(body?.code || '').trim();
    if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Enter the 6-digit code from your email.' }, { status: 400 });
    }

    const limited = await rateLimitedResponse('auth_verify_email', request, 10, 60);
    if (limited) return limited;

    const redis = createKvClient();
    if (!redis) return NextResponse.json({ error: 'System error' }, { status: 500 });

    const result = await consumeCustomerVerifyCode(redis, email, code);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Verification failed.' }, { status: 400 });
    }

    // Find the account (accounts older than this feature count as verified, so
    // an already-verified user reaching here just logs in).
    const raw = await redis.hgetall(USERS_KEY);
    let user: any = null;
    if (raw) {
      for (const [, v] of Object.entries(raw)) {
        const u = safeParseKvItem<any>(v);
        if (u && String(u.email || '').toLowerCase() === email) { user = u; break; }
      }
    }
    if (!user) {
      return NextResponse.json({ error: 'Account not found — please sign up again.' }, { status: 404 });
    }
    if (user.emailVerified === true) {
      return NextResponse.json({ error: 'This email is already verified — log in instead.' }, { status: 400 });
    }

    const { updatedUser, welcomeCode, rewardsGranted } = await grantWelcomeRewards(redis, user, email);
    await trySendWelcomeEmail(email, welcomeCode);

    // H7: read the balance and role back from public.customers rather than
    // trusting the object we just built. grantWelcomeRewards already puts the
    // authoritative number on updatedUser, but re-reading is what makes this
    // route a reader of the authoritative store — if the points write failed,
    // this returns the balance that really exists instead of the one we hoped
    // for. The session is minted from the same numbers so /account and the
    // cookie cannot disagree the moment the customer lands.
    const tenantId = await ensureDefaultTenant();
    const profile = await readProfile(tenantId, email);
    if (!rewardsGranted) {
      console.error('[verify-email] ' + email + ' verified but welcome points were not granted');
    }
    const rewards = profile?.rewardsBalance ?? 0;
    const role = profile?.role || user.role || 'customer';
    updatedUser.rewards = rewards;
    updatedUser.role = role;

    const token = await createCustomerSession(redis, email, updatedUser);

    const response = NextResponse.json({
      success: true,
      verified: true,
      user: { id: user.id, email, role, rewards, welcomePromoCode: welcomeCode },
    });
    createSessionCookie(response, token);
    return response;
  } catch (err: any) {
    console.error('[verify-email] Error:', err);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}

