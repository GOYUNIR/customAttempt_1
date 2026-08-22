import { NextResponse } from 'next/server';
import { createRedisClient, ADMIN_DEVICE_COOKIE } from '@/lib/server-config';
import { issueAdminDevice, isSuperAdminSession } from '@/lib/admin-verify';
import { verifySuperAdminSignIn, supabaseConfigured } from '@/services/config/supabase-client';
import { isPlatformConfigured } from '@/services/config/platform-settings';
import { isValidEmail, isValidPassword } from '@/lib/validation';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * /api/admin/super-login — Supabase master-account sign-in.
 *
 * The Setup Wizard creates a master super-admin (Supabase Auth user flagged
 * `is_super_admin`). This route lets that account sign into the admin portal
 * WITHOUT the env Basic-Auth password: it verifies the Supabase credentials +
 * super-admin flag, then issues an `admin:devices` cookie with `superAdmin:
 * true`. middleware.ts treats that session as full authorization (skipping
 * Basic Auth and the email 2FA step).
 *
 *   POST  { email, password, remember? }  →  verify + set the device cookie
 *   GET                                    →  { configured, signedIn } status
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

  if (!supabaseConfigured()) {
    return NextResponse.json(
      {
        error:
          'Supabase is not configured: SUPABASE_URL and SUPABASE_ANON_KEY are not set in the environment, so the super-admin account cannot be verified. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in your hosting platform (and redeploy), then try again. (Credentials entered inline in the Setup Wizard only last for the current server session.)',
      },
      { status: 503 },
    );
  }

  const limited = await rateLimitedResponse('admin_super_login', request, 10, 60);
  if (limited) return limited;

  const account = await verifySuperAdminSignIn(email, password);
  if (!account) {
    // Generic message — never reveal whether the email exists or the user is a
    // super-admin (account enumeration).
    return NextResponse.json({ error: 'Invalid credentials or not a super-admin.' }, { status: 401 });
  }

  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ error: 'Redis offline.' }, { status: 500 });
  }

  const remember = body?.remember === true;
  const { token, maxAgeSeconds } = await issueAdminDevice(redis, account.email, remember, {
    superAdmin: true,
  });

  const response = NextResponse.json({ ok: true, email: account.email, remember });
  response.cookies.set(ADMIN_DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeSeconds,
    path: '/',
  });
  return response;
}

export async function GET(request: Request) {
  return NextResponse.json({
    configured: (await isPlatformConfigured()) === true,
    signedIn: await isSuperAdminSession(request),
  });
}
