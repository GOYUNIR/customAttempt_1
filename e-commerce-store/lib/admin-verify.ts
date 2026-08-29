/**
 * Server-side helpers for the admin portal's two-step email verification.
 *
 * Flow: the operator's browser must already pass HTTP Basic Auth (proxy.ts).
 * proxy.ts then requires a valid device cookie (`goyunir_admin_device`) for
 * every /api/admin request EXCEPT the verify-* endpoints and the /admin page
 * itself. To get that cookie the operator types their admin email, receives a
 * 6-digit one-time code, and confirms it here. The device token is stored in
 * a single Redis hash (`admin:devices`, field = token) so verified browsers can
 * be revoked by deleting one field — and it is scoped per browser with an
 * httpOnly cookie.
 *
 * Rate limiting: wrong-code attempts are capped (5 per email per 15 min) and
 * resends are throttled (1 per 60s), so the code cannot be brute-forced.
 */

import { randomBytes, createHash, randomInt, timingSafeEqual } from 'crypto';
import {
  ADMIN_DEVICES_KEY,
  adminVerifyKey,
  adminAuthKey,
  ADMIN_AUTH_COOKIE,
} from '@/lib/redis-keys';
import { createRedisClient, safeParseRedisItem, getAdminVerifyEmail, adminRequestAuthorized } from '@/lib/server-config';
import { sendAdminVerificationEmail } from '@/lib/email';

const CODE_TTL_SECONDS = 10 * 60; // 10 minutes
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 15 * 60; // 15 minute lockout window
const RESEND_THROTTLE_SECONDS = 60;
const DEVICE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days ("remember device")
const SESSION_DEVICE_TTL_SECONDS = 24 * 60 * 60; // 1 day ("this browser only")

// The whole 2FA challenge for one email lives in a SINGLE TTL key
// (`admin:verify:<email>`), whose payload carries the code hash, the resend
// throttle stamp, the wrong-attempt counter and the lockout deadline. No
// separate `admin:verify_attempts:*` / `admin:send_attempts:*` keys — the
// Redis browser stays tidy no matter how often the operator signs in.
type AdminChallenge = {
  codeHash: string;
  createdAt: number;
  lastSentAt: number;
  attempts: number;
  lockoutUntil: number;
};

async function readChallenge(redis: any, email: string): Promise<AdminChallenge | null> {
  const raw = await redis.get(adminVerifyKey(email)).catch(() => null);
  if (!raw) return null;
  // Upstash auto-deserializes JSON stored via setex — handle both forms.
  const parsed = safeParseRedisItem<Partial<AdminChallenge>>(raw) || {};
  return {
    codeHash: String(parsed.codeHash || ''),
    createdAt: Number(parsed.createdAt) || 0,
    lastSentAt: Number(parsed.lastSentAt) || 0,
    attempts: Number(parsed.attempts) || 0,
    lockoutUntil: Number(parsed.lockoutUntil) || 0,
  };
}

async function writeChallenge(redis: any, email: string, challenge: AdminChallenge) {
  await redis.setex(adminVerifyKey(email), CODE_TTL_SECONDS, JSON.stringify(challenge));
}

export function generateAdminCode(): string {
  // 6 digits, zero-padded so "042913" style codes are valid too. crypto.randomInt
  // (never Math.random) so the code can't be predicted.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  const salt = randomBytes(8).toString('hex');
  return `${salt}:${createHash('sha256').update(salt + ':' + code).digest('hex')}`;
}

function verifyCodeHash(hashed: string, code: string): boolean {
  const [salt, expected] = String(hashed || '').split(':');
  if (!salt || !expected) return false;
  const actual = createHash('sha256').update(salt + ':' + code).digest('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Create (or refresh) an admin sign-in challenge for `email` and email the
 * code. Throttled to one send per email per 60 seconds. In non-production
 * environments the code is also returned as `devCode` so local development
 * works without a configured inbox.
 */
export async function issueAdminCode(
  redis: any,
  email: string,
): Promise<{ ok: boolean; devCode?: string; error?: string; throttled?: boolean; locked?: boolean }> {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { ok: false, error: 'Email required.' };

  const existing = await readChallenge(redis, normalized);
  const now = Date.now();

  // Active lockout: refuse to mint a fresh code until the window passes.
  if (existing && existing.lockoutUntil > now) {
    const remaining = Math.max(1, Math.ceil((existing.lockoutUntil - now) / 1000));
    return { ok: false, locked: true, error: `Too many failed attempts. Try again in ${Math.ceil(remaining / 60)} minute(s).` };
  }

  // Resend throttle.
  if (existing && existing.lastSentAt && now - existing.lastSentAt < RESEND_THROTTLE_SECONDS * 1000) {
    const remaining = Math.max(1, Math.ceil(RESEND_THROTTLE_SECONDS - (now - existing.lastSentAt) / 1000));
    return { ok: false, throttled: true, error: `Please wait ${remaining}s before requesting another code.` };
  }

  const code = generateAdminCode();
  // Preserve the wrong-attempt count across refreshes so banking 4 wrong tries
  // on one code still counts toward the lockout on the next code.
  await writeChallenge(redis, normalized, {
    codeHash: hashCode(code),
    createdAt: now,
    lastSentAt: now,
    attempts: existing ? existing.attempts : 0,
    lockoutUntil: 0,
  });

  const res = await sendAdminVerificationEmail({ to: normalized, code });
  if (res && res.ok === false && !('skipped' in res && res.skipped === true)) {
    // Email provider failed — don't silently strand the operator. In production
    // this is fatal (the code is only deliverable by email). Outside production
    // the challenge is already stored above and devCode is echoed below, so a
    // fresh clone stays usable even when Resend rejects the sandbox recipient
    // (e.g. "you can only send testing emails to your own email address").
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, error: 'Could not send the verification email. Check RESEND_API_KEY / ADMIN_VERIFY_EMAIL.' };
    }
  }
  let devCode: string | undefined;
  if (process.env.NODE_ENV !== 'production') {
    devCode = code;
  }
  return { ok: true, devCode };
}

/**
 * Validate a submitted one-time code for `email`. Consumes the challenge on
 * success; on repeated failures the email is locked for 15 minutes.
 */
export async function consumeAdminCode(
  redis: any,
  email: string,
  code: string,
): Promise<{ ok: boolean; error?: string; locked?: boolean }> {
  const normalized = String(email || '').trim().toLowerCase();
  const existing = await readChallenge(redis, normalized);
  if (!existing) {
    return { ok: false, error: 'No active code. Request a new one.' };
  }
  if (existing.lockoutUntil > Date.now()) {
    return { ok: false, locked: true, error: 'Too many failed attempts. Try again in 15 minutes.' };
  }

  if (!verifyCodeHash(existing.codeHash, String(code || '').trim())) {
    const next = existing.attempts + 1;
    await writeChallenge(redis, normalized, {
      ...existing,
      attempts: next,
      lockoutUntil: next >= MAX_ATTEMPTS ? Date.now() + ATTEMPT_WINDOW_SECONDS * 1000 : existing.lockoutUntil,
    });
    return {
      ok: false,
      error:
        next >= MAX_ATTEMPTS
          ? 'Too many failed attempts. Try again in 15 minutes.'
          : `Incorrect code. ${MAX_ATTEMPTS - next} attempt${MAX_ATTEMPTS - next === 1 ? '' : 's'} left.`,
    };
  }

  await redis.del(adminVerifyKey(normalized));
  return { ok: true };
}

/** Issue a fresh device token for the 2FA-gated admin requests. Tokens live in
 * the single `admin:devices` hash (field = token) with an explicit `expiresAt`
 * timestamp — hash fields can't carry a per-field TTL, so expiry is enforced
 * lazily by `isAdminDeviceValid` on the next check. */
export async function issueAdminDevice(
  redis: any,
  email: string,
  remember: boolean,
  meta: Record<string, unknown> = {},
): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = randomBytes(32).toString('hex');
  const maxAgeSeconds = remember ? DEVICE_TTL_SECONDS : SESSION_DEVICE_TTL_SECONDS;
  await redis.hset(ADMIN_DEVICES_KEY, {
    [token]: JSON.stringify({
      email: String(email || '').trim().toLowerCase(),
      createdAt: Date.now(),
      expiresAt: Date.now() + maxAgeSeconds * 1000,
      ...meta,
    }),
  });
  return { token, maxAgeSeconds };
}

/** Whether a device token is currently valid (used by proxy.ts on every admin request). */
export async function isAdminDeviceValid(redis: any, token: string): Promise<boolean> {
  if (!token) return false;
  const raw = await redis.hget(ADMIN_DEVICES_KEY, token).catch(() => null);
  if (!raw) return false;
  // Same Upstash deserialization nuance as consumeAdminCode — `raw` may already
  // be the parsed object, so JSON.parse(String(raw)) would throw on
  // "[object Object]" and make every /api/admin request return 401
  // ADMIN_2FA_REQUIRED even after a successful code confirm.
  const parsed = safeParseRedisItem<{ email?: string; createdAt?: number; expiresAt?: number }>(raw);
  if (!parsed) return false;
  // Lazy expiry: hash fields can't expire on their own, so an expired token is
  // removed the first time it is checked — keeps `admin:devices` self-cleaning.
  if (Number(parsed.expiresAt) > 0 && Date.now() > Number(parsed.expiresAt)) {
    try { await redis.hdel(ADMIN_DEVICES_KEY, token); } catch { /* best-effort */ }
    return false;
  }
  return Boolean(parsed.email || parsed.createdAt);
}

/** Extract the device token from a Request's cookie header (proxy + routes). */
export function adminDeviceTokenFromRequest(request: Request): string {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)goyunir_admin_device=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/** Read + lazy-expire the parsed `admin:devices` record for a token. Returns the
 *  record (which may carry `superAdmin: true`) or null when the token is unknown
 *  or expired. Mirrors the expiry discipline of `isAdminDeviceValid` — hash
 *  fields can't carry a per-field TTL, so expired entries are deleted the first
 *  time they're checked. */
export async function readAdminDevice(
  redis: any,
  token: string,
): Promise<{ email?: string; createdAt?: number; expiresAt?: number; superAdmin?: boolean } | null> {
  if (!token) return null;
  const raw = await redis.hget(ADMIN_DEVICES_KEY, token).catch(() => null);
  if (!raw) return null;
  const parsed = safeParseRedisItem<{ email?: string; createdAt?: number; expiresAt?: number; superAdmin?: boolean }>(raw);
  if (!parsed) return null;
  if (Number(parsed.expiresAt) > 0 && Date.now() > Number(parsed.expiresAt)) {
    try {
      await redis.hdel(ADMIN_DEVICES_KEY, token);
    } catch {
      /* best-effort */
    }
    return null;
  }
  return parsed;
}

/** Whether the current request's device cookie maps to a SUPER-ADMIN session —
 *  i.e. the master account signed in through /api/admin/super-login (Supabase).
 *  Used to let that account re-configure providers without the env Basic-Auth
 *  password. */
export async function isSuperAdminSession(request: Request): Promise<boolean> {
  const redis = createRedisClient();
  if (!redis) return false;
  const token = adminDeviceTokenFromRequest(request);
  const record = await readAdminDevice(redis, token);
  return record?.superAdmin === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin login sessions (in-site /admin/login form).
//
// The native browser Basic-Auth dialog was replaced by a neat in-site login
// form. After the email + password are verified, `issueAdminAuthSession()` mints
// a short-lived token stored as a TTL string (`admin:auth:<token>` = the email)
// and carried in the `goyunir_admin_auth` cookie. That cookie is the "password
// passed" layer; the operator must STILL confirm the emailed 2FA code (which
// issues the long-lived device cookie) before the portal unlocks.
// ─────────────────────────────────────────────────────────────────────────────

const AUTH_SESSION_TTL_SECONDS = 15 * 60; // 15 minutes

/** Extract the login-session token from the request's Cookie header. */
export function adminAuthTokenFromRequest(request: Request): string {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_AUTH_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

/** Mint a fresh in-site login session for `email` and return its token. */
export async function issueAdminAuthSession(
  redis: any,
  email: string,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const normalized = String(email || '').trim().toLowerCase();
  await redis.setex(
    adminAuthKey(token),
    AUTH_SESSION_TTL_SECONDS,
    JSON.stringify({ email: normalized, createdAt: Date.now() }),
  );
  return token;
}

/** Read + validate a login-session token. Returns the verified email, or null
 *  when the token is missing / unknown / expired. The value is a TTL string so
 *  expired sessions vanish on their own — no lazy cleanup required. */
export async function consumeAdminAuthSession(
  redis: any,
  token: string,
): Promise<{ email: string } | null> {
  if (!token) return null;
  const raw = await redis.get(adminAuthKey(token)).catch(() => null);
  if (!raw) return null;
  const parsed = safeParseRedisItem<{ email?: string; createdAt?: number }>(raw);
  const email = String(parsed?.email || '').trim().toLowerCase();
  if (!email) return null;
  return { email };
}

/** Resolve the verified admin email for the 2FA step: prefer the in-site login
 *  session's email, then fall back to ADMIN_VERIFY_EMAIL / SUPPORT_EMAIL (the
 *  legacy env-driven inbox). */
export async function resolveAdminLoginEmail(request: Request): Promise<string> {
  const redis = createRedisClient();
  const token = adminAuthTokenFromRequest(request);
  if (redis && token) {
    const session = await consumeAdminAuthSession(redis, token);
    if (session?.email) return session.email;
  }
  return getAdminVerifyEmail();
}

/** Authorize the admin 2FA step: either the legacy Basic-Auth header/password OR
 *  a valid in-site login-session cookie. This is what the verify-* routes use on
 *  top of the middleware's own gate (defense-in-depth). */
export async function adminLoginAuthorized(
  request: Request,
  suppliedPassword?: string,
): Promise<boolean> {
  if (adminRequestAuthorized(request, suppliedPassword)) return true;
  const redis = createRedisClient();
  if (!redis) return false;
  const token = adminAuthTokenFromRequest(request);
  if (token) {
    const session = await consumeAdminAuthSession(redis, token);
    if (session?.email) return true;
  }
  // A valid device cookie is ALSO full authorization. The middleware already
  // trusts it for every /api/admin request, so the verify-* routes must too —
  // this is what lets the break-lockout bypass (and /api/admin/super-login)
  // reach /api/admin/verify-status without a separate login-session cookie.
  const deviceToken = adminDeviceTokenFromRequest(request);
  if (deviceToken) {
    return await isAdminDeviceValid(redis, deviceToken).catch(() => false);
  }
  return false;
}

/**
 * Full admin authorization for /api/admin routes (read + write). Accepts ANY
 * credential the middleware's Gate 1 trusts:
 *   1. the Basic-Auth admin password (HTTP header, or a supplied body/query
 *      value), or
 *   2. a super-admin device session (Supabase master-account sign-in), or
 *   3. a verified device cookie (issued after the emailed 2FA code).
 *
 * A bare login-session cookie is deliberately NOT sufficient here — it only
 * proves the password was entered, not that the 2FA step was completed. Use
 * `adminLoginAuthorized()` for the verify-* 2FA routes instead.
 */
export async function adminAuthorized(
  request: Request,
  suppliedPassword?: string,
): Promise<boolean> {
  if (adminRequestAuthorized(request, suppliedPassword)) return true;
  if (await isSuperAdminSession(request)) return true;
  const redis = createRedisClient();
  if (!redis) return false;
  const token = adminDeviceTokenFromRequest(request);
  if (!token) return false;
  return isAdminDeviceValid(redis, token).catch(() => false);
}


