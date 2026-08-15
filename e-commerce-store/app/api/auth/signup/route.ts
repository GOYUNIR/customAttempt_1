import { NextResponse } from 'next/server';
import { createRedisClient, safeParseRedisItem, USERS_KEY } from '@/lib/server-config';
import { randomBytes, scryptSync } from 'crypto';
import { issueCustomerVerifyCode } from '@/lib/customer-verify';
import { isValidEmail, isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

/**
 * Signup now requires email verification before any rewards are granted:
 *  1. The account is created UNVERIFIED with 0 points and no welcome promo.
 *  2. A 6-digit code is emailed to the address (`/api/auth/verify-email`).
 *  3. Only after the code is confirmed does the account get the 250 welcome
 *     points + one-time 10% credit, and a session is created.
 * This stops automated bots from farming welcome rewards with fake inboxes.
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
  let existing = false;
  if (raw) {
    for (const [, v] of Object.entries(raw)) {
      const u = safeParseRedisItem<any>(v);
      if (u && String(u.email || '').toLowerCase() === normalizedEmail) { existing = true; break; }
    }
  }
  if (existing) return NextResponse.json({ error: 'User already exists' }, { status: 400 });

  const salt = randomBytes(16).toString('hex');
  const hashed = hashPassword(password, salt);
  const id = `usr_${Date.now().toString(36)}`;

  const user = {
    id,
    email: normalizedEmail,
    password: `${salt}:${hashed}`,
    role: 'customer',
    // Deliberately locked until the inbox is proven real.
    emailVerified: false,
    rewards: 0,
    emailOptIn: emailOptIn === true,
    termsAgreedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  await redis.hset(USERS_KEY, { [id]: JSON.stringify(user) });

  // Email the verification code (throttled server-side). If the email provider
  // is unavailable the account still exists — the customer can retry the code
  // from the verify screen or /account later.
  const verify = await issueCustomerVerifyCode(redis, normalizedEmail);

  return NextResponse.json({
    success: true,
    needsVerification: true,
    email: normalizedEmail,
    // Non-production only: lets local development see the code without a real inbox.
    devCode: verify.devCode,
  });
}

