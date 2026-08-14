/**
 * Customer email-verification helpers (signup flow).
 *
 * Accounts are created "unverified" with 0 rewards and no welcome promo. A
 * 6-digit code is emailed to the address; only after the code is confirmed
 * (`/api/auth/verify-email`) are the welcome points + one-time member credit
 * issued. This stops automated signup bots from farming welcome rewards with
 * throwaway/fake inboxes.
 *
 * The challenge lives in `auth:verify:<email>` (30 min TTL) and carries a
 * hashed code + attempt counter. Resends are throttled to one per 60s and the
 * code locks after 6 wrong guesses.
 */

import { randomBytes, createHash } from 'crypto';
import { emailVerifyKey } from '@/lib/redis-keys';
import { sendCustomerVerificationEmail } from '@/lib/email';

const VERIFY_TTL_SECONDS = 30 * 60; // 30 minutes
const MAX_ATTEMPTS = 6;
const RESEND_THROTTLE_SECONDS = 60;

export function generateVerifyCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  const salt = randomBytes(8).toString('hex');
  return `${salt}:${createHash('sha256').update(salt + ':' + code).digest('hex')}`;
}

function verifyCodeHash(hashed: string, code: string): boolean {
  const [salt, expected] = String(hashed || '').split(':');
  if (!salt || !expected) return false;
  return createHash('sha256').update(salt + ':' + code).digest('hex') === expected;
}

/** Email a fresh verification code to `email`, throttled to one per 60 seconds. */
export async function issueCustomerVerifyCode(
  redis: any,
  email: string,
): Promise<{ ok: boolean; devCode?: string; error?: string; throttled?: boolean }> {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { ok: false, error: 'Email required.' };

  const key = emailVerifyKey(normalized);
  const existing = await redis.get(key).catch(() => null);
  if (existing) {
    try {
      const prev = JSON.parse(String(existing));
      if (prev && Date.now() - Number(prev.createdAt || 0) < RESEND_THROTTLE_SECONDS * 1000) {
        const wait = Math.max(1, Math.ceil(RESEND_THROTTLE_SECONDS - (Date.now() - Number(prev.createdAt || 0)) / 1000));
        return { ok: false, throttled: true, error: `Please wait ${wait}s before requesting another code.` };
      }
    } catch { /* malformed challenge — just overwrite */ }
  }

  const code = generateVerifyCode();
  await redis.setex(key, VERIFY_TTL_SECONDS, JSON.stringify({
    codeHash: hashCode(code),
    attempts: 0,
    createdAt: Date.now(),
  }));

  const res = await sendCustomerVerificationEmail({ to: normalized, code });
  if (res && res.ok === false && !('skipped' in res && res.skipped === true)) {
    return { ok: false, error: 'Could not send the verification email. Check RESEND_API_KEY.' };
  }
  let devCode: string | undefined;
  if (process.env.NODE_ENV !== 'production') {
    devCode = code;
  }
  return { ok: true, devCode };
}

/** Confirm a submitted code. Consumes the challenge on success; locks after 6 misses. */
export async function consumeCustomerVerifyCode(
  redis: any,
  email: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = String(email || '').trim().toLowerCase();
  const key = emailVerifyKey(normalized);
  const raw = await redis.get(key).catch(() => null);
  if (!raw) {
    return { ok: false, error: 'No active code — request a new one.' };
  }
  let payload: { codeHash?: string; attempts?: number } = {};
  try { payload = JSON.parse(String(raw)); } catch { payload = {}; }

  if (!verifyCodeHash(payload.codeHash || '', String(code || '').trim())) {
    const attempts = Number(payload.attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await redis.del(key);
      return { ok: false, error: 'Too many failed attempts. Request a new code.' };
    }
    await redis.setex(key, VERIFY_TTL_SECONDS, JSON.stringify({ ...payload, attempts }));
    return {
      ok: false,
      error: `Incorrect code. ${MAX_ATTEMPTS - attempts} attempt${MAX_ATTEMPTS - attempts === 1 ? '' : 's'} left.`,
    };
  }

  await redis.del(key);
  return { ok: true };
}
