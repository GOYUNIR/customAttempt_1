import { NextResponse } from 'next/server';
import { createRedisClient, getAdminVerifyEmail, getAdminPassword, verifyAdminPassword, ADMIN_AUTH_COOKIE } from '@/lib/server-config';
import { issueAdminAuthSession } from '@/lib/admin-verify';
import { verifySuperAdminSignIn, supabaseConfigured, supabaseAuthMissingReason } from '@/services/config/supabase-client';
import { isValidEmail, isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

/**
 * Whether the legacy Basic-Auth fallback can actually accept a login. It needs
 * BOTH a password to compare against AND an admin email to pair with it — the
 * email match is what the fallback branch enforces (`verifyAdminPassword` +
 * `adminEmail === email`). Outside production `getAdminPassword()` returns a
 * documented local dev fallback, so a fresh clone is never locked out here.
 */
function basicAuthLoginUsable(): boolean {
  return Boolean(getAdminPassword()) && Boolean(getAdminVerifyEmail().trim());
}

export const dynamic = 'force-dynamic';

/**
 * /api/admin/login — in-site admin sign-in (replaces the native Basic-Auth dialog).
 *
 * The operator enters their email + password in a neat form at /admin/login. We
 * verify against EITHER the Supabase master admin account (created by the Setup
 * Wizard) OR the legacy ADMIN_BASIC_AUTH_PASSWORD (paired with the admin email).
 * On success a SHORT-LIVED login session (`goyunir_admin_auth` cookie) is set —
 * that is the "password passed" layer. The operator is then taken to /admin,
 * which shows the two-step email verification gate before the portal unlocks.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');

  if (!isValidEmail(email) || !isValidPassword(password)) {
    return NextResponse.json({ error: 'Enter a valid email and password.' }, { status: 400 });
  }

  const limited = await rateLimitedResponse('admin_login', request, 10, 60);
  if (limited) return limited;

  // Readiness gate — only when EVERY login path is unavailable. If Supabase auth
  // is not configured AND the legacy Basic-Auth fallback is unusable, no set of
  // credentials can ever succeed, so a 401 "invalid email or password" would be
  // a lie and trap the operator in the login form. Report the real configuration
  // gap instead. When ANY method is available we fall through and return 401 for
  // genuinely wrong credentials.
  const authReason = supabaseAuthMissingReason();
  if (authReason && !basicAuthLoginUsable()) {
    return NextResponse.json(
      {
        error:
          'Admin login is not configured yet. ' +
          authReason +
          ' Or set the legacy ADMIN_BASIC_AUTH_PASSWORD + ADMIN_VERIFY_EMAIL environment variables to enable the basic-auth fallback.',
        code: 'admin_login_not_configured',
      },
      { status: 503 },
    );
  }

  // 1. Master admin — the Supabase super-admin account created by the wizard.
  let authorized = false;
  if (supabaseConfigured()) {
    const account = await verifySuperAdminSignIn(email, password);
    if (account) authorized = true;
  }

  // 2. Fallback — the legacy Basic-Auth password, paired with the admin email.
  if (!authorized && verifyAdminPassword(password)) {
    const adminEmail = getAdminVerifyEmail();
    if (adminEmail && adminEmail.trim().toLowerCase() === email) authorized = true;
  }

  if (!authorized) {
    // Generic message — never reveal whether the email exists (account enumeration).
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }

  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json(
      { error: 'No storage backend configured — set up your database first, then try again.' },
      { status: 500 },
    );
  }

  const token = await issueAdminAuthSession(redis, email);

  const response = NextResponse.json({ ok: true, needs2fa: true, email });
  response.cookies.set(ADMIN_AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 15 * 60, // 15 minutes — long enough to read the emailed 2FA code
    path: '/',
  });
  return response;
}
