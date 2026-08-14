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

import { randomBytes, createHash } from 'crypto';
import {
  ADMIN_DEVICES_KEY,
  adminVerifyKey,
  adminVerifyAttemptsKey,
  adminSendAttemptsKey,
} from '@/lib/redis-keys';
import { safeParseRedisItem } from '@/lib/server-config';
import { sendAdminVerificationEmail } from '@/lib/email';

const CODE_TTL_SECONDS = 10 * 60; // 10 minutes
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 15 * 60; // 15 minute lockout window
const RESEND_THROTTLE_SECONDS = 60;
const DEVICE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days ("remember device")
const SESSION_DEVICE_TTL_SECONDS = 24 * 60 * 60; // 1 day ("this browser only")

export function generateAdminCode(): string {
  // 6 digits, zero-padded so "042913" style codes are valid too.
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  const salt = randomBytes(8).toString('hex');
  return `${salt}:${createHash('sha256').update(salt + ':' + code).digest('hex')}`;
}

function verifyCodeHash(hashed: string, code: string): boolean {
  const [salt, expected] = String(hashed || '').split(':');
  if (!salt || !expected) return false;
  const actual = createHash('sha256').update(salt + ':' + code).digest('hex');
  return actual === expected;
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
): Promise<{ ok: boolean; devCode?: string; error?: string; throttled?: boolean }> {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { ok: false, error: 'Email required.' };

  // Resend throttle.
  const sendKey = adminSendAttemptsKey(normalized);
  const lastSend = await redis.get(sendKey).catch(() => null);
  if (lastSend && Date.now() - Number(lastSend) < RESEND_THROTTLE_SECONDS * 1000) {
    const remaining = Math.max(1, Math.ceil(RESEND_THROTTLE_SECONDS - (Date.now() - Number(lastSend)) / 1000));
    return { ok: false, throttled: true, error: `Please wait ${remaining}s before requesting another code.` };
  }

  const code = generateAdminCode();
  await redis.setex(adminVerifyKey(normalized), CODE_TTL_SECONDS, JSON.stringify({
    codeHash: hashCode(code),
    createdAt: Date.now(),
  }));
  await redis.setex(sendKey, RESEND_THROTTLE_SECONDS, String(Date.now()));

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
  const attemptsKey = adminVerifyAttemptsKey(normalized);
  const attempts = Number(await redis.get(attemptsKey).catch(() => 0)) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    return { ok: false, locked: true, error: 'Too many failed attempts. Try again in 15 minutes.' };
  }

  const raw = await redis.get(adminVerifyKey(normalized)).catch(() => null);
  if (!raw) {
    return { ok: false, error: 'No active code. Request a new one.' };
  }
  // The Upstash client auto-deserializes JSON stored via setex, so `raw` is
  // often ALREADY an object. JSON.parse(String(raw)) would then throw on
  // "[object Object]" and every code would be rejected as "Incorrect code" —
  // use the shared safeParseRedisItem helper (handles both string and object).
  const payload = safeParseRedisItem<{ codeHash?: string }>(raw) || {};

  if (!verifyCodeHash(payload.codeHash || '', String(code || '').trim())) {
    const next = attempts + 1;
    await redis.setex(attemptsKey, ATTEMPT_WINDOW_SECONDS, String(next));
    return {
      ok: false,
      error:
        next >= MAX_ATTEMPTS
          ? 'Too many failed attempts. Try again in 15 minutes.'
          : `Incorrect code. ${MAX_ATTEMPTS - next} attempt${MAX_ATTEMPTS - next === 1 ? '' : 's'} left.`,
    };
  }

  await redis.del(adminVerifyKey(normalized));
  await redis.del(attemptsKey);
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
): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = randomBytes(32).toString('hex');
  const maxAgeSeconds = remember ? DEVICE_TTL_SECONDS : SESSION_DEVICE_TTL_SECONDS;
  await redis.hset(ADMIN_DEVICES_KEY, {
    [token]: JSON.stringify({
      email: String(email || '').trim().toLowerCase(),
      createdAt: Date.now(),
      expiresAt: Date.now() + maxAgeSeconds * 1000,
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

