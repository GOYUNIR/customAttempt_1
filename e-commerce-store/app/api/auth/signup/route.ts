import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY, STORE_CONFIG_KEY } from '@/lib/server-config';
import { randomBytes, scryptSync } from 'crypto';
import { issueCustomerVerifyCode } from '@/lib/customer-verify';
import { grantWelcomeRewards, createCustomerSession, trySendWelcomeEmail, CUSTOMER_SESSION_TTL_SECONDS } from '@/lib/customer-rewards';
import { EmailFactory } from '@/services/email/factory';
import { isValidEmail, isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

/** Whether any transactional email provider is configured (wizard or env). */
async function emailProviderConfigured(): Promise<boolean> {
  try {
    return Boolean(await EmailFactory.getDriver({ force: true }));
  } catch {
    return false;
  }
}

/**
 * Whether mandatory customer signup email verification (2FA) is enabled.
 * Admin toggle under /admin → Settings → Rewards & Points ("Require email
 * verification at signup"). Defaults to ON (secure). When OFF, signup creates
 * a verified account immediately — no 6-digit code is sent.
 */
async function requireSignup2FA(redis: any): Promise<boolean> {
  try {
    const raw = await redis.get(STORE_CONFIG_KEY);
    const config = safeParseRedisItem<any>(raw) || {};
    return config.requireSignup2FA !== false;
  } catch {
    return true;
  }
}

/**
 * Signup behavior depends on whether an email provider exists:
 *
 * - EMAIL CONFIGURED — the account is created UNVERIFIED (0 points, no welcome
 *   promo) and a 6-digit code is emailed. Only after the code is confirmed does
 *   the account get the welcome rewards + session (anti-bot: proves the inbox is
 *   real before rewards are granted).
 *
 * - NO EMAIL PROVIDER — there is nothing to verify against, so the account is
 *   created verified and the welcome rewards + session are granted immediately.
 *   The customer is never held hostage behind a code that cannot arrive.
 */
export async function POST(request: Request) {
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { email, password, emailOptIn, termsAgreed } = body;
  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
  }
  if (termsAgreed !== true) {
    return NextResponse.json({ error: 'You must agree to the Terms of Service and Privacy Policy to create an account.' }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  }
  if (!isValidPassword(password)) {
    return NextResponse.json({ error: 'Password must be between 6 and 128 characters.' }, { status: 400 });
  }

  const limited = await rateLimitedResponse('auth_signup', request, 10, 60);
  if (limited) return limited;

  const redis = createRedisClient();
  if (!redis) return NextResponse.json({ error: 'System error' }, { status: 500 });

  const normalizedEmail = String(email).trim().toLowerCase();

  // check if user exists (accounts older than this feature count as verified)
  const raw = await redis.hgetall(USERS_KEY);
  let existingUser: any = null;
  if (raw) {
    for (const [, v] of Object.entries(raw)) {
      const u = safeParseRedisItem<any>(v);
      if (u && String(u.email || '').toLowerCase() === normalizedEmail) { existingUser = u; break; }
    }
  }

  // A VERIFIED account already exists → hard 400 (normal duplicate-signup).
  if (existingUser && existingUser.emailVerified === true) {
    return NextResponse.json({ error: 'User already exists' }, { status: 400 });
  }

  // An UNVERIFIED account from a previous signup → re-send the code instead of
  // a confusing 400. This is the "retry signup with an unverified email" path.
  if (existingUser) {
    const resend = await issueCustomerVerifyCode(redis, normalizedEmail);
    if (!resend.ok) {
      if (resend.throttled) {
        return NextResponse.json({ error: resend.error || 'Please wait before requesting another code.' }, { status: 429 });
      }
      return NextResponse.json({ error: "We couldn't email your verification code. Please try again." }, { status: 502 });
    }
    return NextResponse.json({
      success: true,
      needsVerification: true,
      email: normalizedEmail,
      resent: true,
      devCode: resend.devCode,
    });
  }

  const salt = randomBytes(16).toString('hex');
  const hashed = hashPassword(password, salt);
  const id = `usr_${Date.now().toString(36)}`;

  const emailConfigured = await emailProviderConfigured();
  const twoFactorRequired = (await requireSignup2FA(redis)) && emailConfigured;

  const user = {
    id,
    email: normalizedEmail,
    password: `${salt}:${hashed}`,
    role: 'customer',
    // Verified immediately when the admin disables mandatory signup 2FA, or when
    // there is no email provider to deliver a code with. Otherwise the account
    // is created UNVERIFIED (0 rewards, no session) and locked until the emailed
    // 6-digit code is confirmed.
    emailVerified: !twoFactorRequired,
    rewards: 0,
    emailOptIn: emailOptIn === true,
    termsAgreedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  await redis.hset(USERS_KEY, { [id]: JSON.stringify(user) });

  // 2FA not required (admin toggle off, or no email provider) → unlock the
  // account + rewards right now and sign them in.
  if (!twoFactorRequired) {
    const { updatedUser, welcomeCode } = await grantWelcomeRewards(redis, user, normalizedEmail);
    await trySendWelcomeEmail(normalizedEmail, welcomeCode);

    const token = await createCustomerSession(redis, normalizedEmail, updatedUser);
    const response = NextResponse.json({
      success: true,
      needsVerification: false,
      user: { id, email: normalizedEmail, role: 'customer', rewards: updatedUser.rewards, welcomePromoCode: welcomeCode },
    });
    response.cookies.set('goyunir_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: CUSTOMER_SESSION_TTL_SECONDS,
      path: '/',
    });
    return response;
  }

  // Email the verification code (throttled server-side). If the send fails we
  // surface the failure clearly instead of stranding the customer with a
  // "code is in your email" message that never arrives.
  const verify = await issueCustomerVerifyCode(redis, normalizedEmail);
  if (!verify.ok) {
    if (verify.throttled) {
      return NextResponse.json({ error: verify.error || 'Please wait before requesting another code.' }, { status: 429 });
    }
    return NextResponse.json({ error: "We couldn't email your verification code. Please try again." }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    needsVerification: true,
    email: normalizedEmail,
    // Non-production only: lets local development see the code without a real inbox.
    devCode: verify.devCode,
  });
}


