import { NextResponse } from 'next/server';
import { createKvClient, getAdminVerifyEmail, getAdminPassword, verifyAdminPassword, ADMIN_AUTH_COOKIE, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { issueAdminAuthSession, issueAdminDevice } from '@/lib/admin-verify';
import { verifySuperAdminCredentials, supabaseConfigured, supabaseAuthMissingReason } from '@/services/config/supabase-client';
import { readStaffIdentity, deviceMetaFor, type StaffIdentity } from '@/lib/staff-identity';
import { EmailFactory } from '@/services/email/factory';
import { isValidEmail, isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';
import { portalCookieAttrs } from '@/lib/portal-cookies';

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

/**
 * Whether ANY transactional email provider is available — either persisted in
 * `global_platform_settings` (Setup Wizard) or a legacy env binding such as
 * RESEND_API_KEY / POSTMARK_API_KEY / SENDGRID_API_KEY. This is the single
 * source of truth that decides whether the 6-digit two-step code can even be
 * delivered, and it is read from the same factory the email senders use so the
 * two can never drift.
 */
async function emailProviderConfigured(): Promise<boolean> {
  try {
    return Boolean(await EmailFactory.getDriver({ force: true }));
  } catch {
    // If the email state cannot be determined, fail OPEN: never lock the
    // operator out of their own admin portal behind a code that can't arrive.
    return false;
  }
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

  // 1. ANY staff account in Supabase Auth — not just the master super-admin.
  //
  // This used to call verifySuperAdminSignIn, which fails closed for anyone
  // without is_super_admin. That made this endpoint — the ONE login all three
  // staff realms post to — accept exactly one account in the entire platform,
  // so an invited sales rep could be created perfectly and still never sign in.
  //
  // The password is verified against Supabase Auth first; the ROLE then comes
  // from public.users (migration 00024), never from the credentials. A valid
  // password for someone with no staff row is not a staff sign-in.
  let authorized = false;
  let identity: StaffIdentity | null = null;
  if (supabaseConfigured()) {
    const credentials = await verifySuperAdminCredentials(email, password);
    if (credentials) {
      identity = await readStaffIdentity(credentials.email);
      if (identity) authorized = true;
      else {
        // Correct password, but this person is not staff (a customer account,
        // or a staff row that was removed). Refused, and logged: silently
        // treating it as a bad password would hide a revoked operator still
        // trying to get in.
        console.warn('[admin/login] valid credentials with no staff identity:', credentials.email);
      }
    }
  }

  // 2. Fallback — the legacy Basic-Auth password, paired with the admin email.
  //    It IS the store's own secret, so it stays full-access and role-less.
  if (!authorized && verifyAdminPassword(password)) {
    const adminEmail = getAdminVerifyEmail();
    if (adminEmail && adminEmail.trim().toLowerCase() === email) authorized = true;
  }

  if (!authorized) {
    // Generic message — never reveal whether the email exists (account enumeration).
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }

  const redis = createKvClient();
  if (!redis) {
    return NextResponse.json(
      { error: 'No storage backend configured — set up your database first, then try again.' },
      { status: 500 },
    );
  }

  // BREAK-LOCKOUT BYPASS: when no transactional email provider is configured,
  // a 6-digit OTP can never be delivered. Forcing the two-step gate here would
  // trap the operator behind a code they cannot receive. Grant dashboard access
  // on the correct password alone, and let the portal's Settings screen
  // activate two-step verification once an email provider is configured.
  const twoStepEnabled = await emailProviderConfigured();

  if (!twoStepEnabled) {
    // Issue the long-lived device cookie directly — the operator is now fully
    // signed in. The device carries the REAL role from public.users, so a sales
    // rep signing in here becomes a sales rep and not, as this previously
    // hardcoded, a super-admin. The legacy Basic-Auth path has no identity and
    // keeps its historical full-access grant.
    const meta = identity ? deviceMetaFor(identity) : { superAdmin: true };
    const { token, maxAgeSeconds } = await issueAdminDevice(redis, email, true, meta);
    const response = NextResponse.json({ ok: true, needs2fa: false, twoStepEnabled: false, email });
    response.cookies.set(ADMIN_DEVICE_COOKIE, token, portalCookieAttrs(request, 'admin', maxAgeSeconds));
    return response;
  }

  const token = await issueAdminAuthSession(redis, email);

  const response = NextResponse.json({ ok: true, needs2fa: true, twoStepEnabled: true, email });
  // 15 minutes — long enough to read the emailed 2FA code.
  response.cookies.set(ADMIN_AUTH_COOKIE, token, portalCookieAttrs(request, 'admin', 15 * 60));
  return response;
}
