import { NextResponse } from 'next/server';
import { createRedisClient, adminRequestAuthorized } from '@/lib/server-config';
import {
  adminAuthorized,
  stampStepUp,
  adminDeviceTokenFromRequest,
  readAdminDevice,
} from '@/lib/admin-verify';
import { verifySuperAdminSignIn } from '@/services/config/supabase-client';
import { rateLimitedResponse } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/step-up — re-verify the operator's password/credentials
 * RIGHT NOW and stamp a short-lived (STEP_UP_TTL_MS) freshness marker for
 * this admin browser. Routes that touch a locked system parameter
 * (lib/lockdown.ts) require this stamp before writing, on top of the normal
 * admin-session check — closing the gap where a stolen device cookie alone
 * would otherwise be enough to rotate the Stripe key or storage backend.
 *
 * Two credential paths, matching the two ways an operator can be signed in:
 *   1. The env Basic-Auth admin password (`{ password }`).
 *   2. The Supabase super-admin email+password (`{ email, password }`) —
 *      verified the same way /api/admin/super-login does, but WITHOUT
 *      minting a new device cookie (the operator is already signed in; this
 *      only proves they still have the credential in hand).
 *
 * Requires an existing admin session first (this is a step-UP, not a
 * standalone login) so it can never be used to bootstrap access on its own.
 */
export async function POST(request: Request) {
  if (!(await adminAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitedResponse('admin_step_up', request, 10, 60);
  if (limited) return limited;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const password = String(body?.password || '');
  if (!password) {
    return NextResponse.json({ error: 'Password required.' }, { status: 400 });
  }

  const redis = createRedisClient();
  if (!redis) {
    return NextResponse.json({ error: 'System offline.' }, { status: 500 });
  }

  let verified = adminRequestAuthorized(request, password);

  if (!verified) {
    // Supabase super-admin path: verify against the email already bound to
    // this browser's device cookie (never trust a client-supplied email
    // here — that would let a stolen cookie step itself up against an
    // attacker-controlled Supabase account).
    const token = adminDeviceTokenFromRequest(request);
    const device = token ? await readAdminDevice(redis, token) : null;
    if (device?.superAdmin && device.email) {
      const account = await verifySuperAdminSignIn(device.email, password);
      verified = Boolean(account);
    }
  }

  if (!verified) {
    return NextResponse.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  const stamped = await stampStepUp(redis, request);
  if (!stamped) {
    // No device/login-session cookie to scope the stamp to (e.g. a bare
    // Basic-Auth caller) — that path is already treated as always-fresh by
    // isStepUpVerified(), so this is a no-op success rather than an error.
    return NextResponse.json({ ok: true, stamped: false });
  }

  return NextResponse.json({ ok: true, stamped: true });
}
