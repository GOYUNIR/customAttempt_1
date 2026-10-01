/**
 * SIGNUP GUARD — the app-level throttles, the source of truth for signup
 * abuse (a Cloudflare edge rule in front is a bonus, never relied on).
 * Every number is policy DATA (platform_policies, 00041); the defaults here
 * are only the fallback if that table cannot be read.
 *
 *   per IP     escalating waits past a soft hourly limit (offices and shared
 *              networks slow down, they are not shut out), hard daily cap
 *   per email  daily cap + doubling resend cooldown            } silent:
 *   per domain daily cap, except big shared providers         } same reply
 *   global     hourly and daily circuit breaker: pauses signup by itself,
 *              recovers by itself, alerts the operator at most once an hour
 *   email      signup mail uses at most its share of each provider's DAILY
 *              limit (the governed email driver); then "try again tomorrow"
 * Counters live in the KV store with expiries; the real IP is cf-connecting-ip.
 */
import { getDb } from '@/lib/db/client';
import { inList } from '@/lib/db/query';
import { createKvClient } from '@/lib/server-config';
import { clientIpFromHeaders } from '@/lib/edge-router';

export type SignupPolicy = {
  holdHours: number; ownerAcceptDays: number; activationDays: number;
  ipSoftPerHour: number; ipHardPerDay: number; emailPerDay: number; emailResendCooldownSeconds: number;
  domainPerDay: number; freemailDomains: string[]; globalPerHour: number; globalPerDay: number; breakerPauseMinutes: number;
  termsVersion: string;
};

const DEFAULTS: SignupPolicy = {
  holdHours: 48, ownerAcceptDays: 7, activationDays: 14, ipSoftPerHour: 5, ipHardPerDay: 50, emailPerDay: 3,
  emailResendCooldownSeconds: 60, domainPerDay: 20, freemailDomains: ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com'],
  globalPerHour: 40, globalPerDay: 300, breakerPauseMinutes: 60, termsVersion: 'unknown',
};
const KEYMAP: Record<string, keyof SignupPolicy> = {
  'signup.hold_hours': 'holdHours', 'signup.owner_accept_days': 'ownerAcceptDays', 'signup.activation_days': 'activationDays',
  'signup.ip_soft_per_hour': 'ipSoftPerHour', 'signup.ip_hard_per_day': 'ipHardPerDay', 'signup.email_per_day': 'emailPerDay',
  'signup.email_resend_cooldown_seconds': 'emailResendCooldownSeconds', 'signup.domain_per_day': 'domainPerDay',
  'signup.freemail_domains': 'freemailDomains', 'signup.global_per_hour': 'globalPerHour', 'signup.global_per_day': 'globalPerDay',
  'signup.breaker_pause_minutes': 'breakerPauseMinutes',
  'signup.terms_version': 'termsVersion',
};

let cached: { at: number; policy: SignupPolicy } | null = null;
export async function signupPolicy(): Promise<SignupPolicy> {
  if (cached && Date.now() - cached.at < 30_000) return cached.policy;
  const policy: any = { ...DEFAULTS };
  try {
    const rows = (await getDb().select<any>('platform_policies', { select: ['key', 'value'], limit: 200 })) as any[];
    for (const r of rows) { const k = KEYMAP[r.key]; if (k) policy[k] = r.value; }
  } catch (err) {
    console.error('[signup-guard] policy unreadable, using safe defaults', (err as Error)?.message || err);
  }
  cached = { at: Date.now(), policy };
  return policy;
}

export const signupIp = (request: Request) => clientIpFromHeaders((n) => request.headers.get(n));
export const emailDomain = (email: string) => String(email.split('@')[1] || '').toLowerCase();

export async function isDisposableEmail(email: string): Promise<boolean> {
  const domain = emailDomain(email);
  if (!domain) return true;
  // The domain and each parent (mail.mailinator.com → mailinator.com).
  const parts = domain.split('.');
  const candidates = parts.slice(0, -1).map((_, i) => parts.slice(i).join('.'));
  const rows = (await getDb().select<any>('disposable_email_domains', { where: { domain: inList(candidates) }, select: ['domain'], limit: 5 })) as any[];
  return rows.length > 0;
}

const hourKey = () => new Date().toISOString().slice(0, 13);
const dayKey = () => new Date().toISOString().slice(0, 10);

async function bump(kv: any, key: string, ttlSeconds: number): Promise<number> {
  const n = Number(await kv.incr(key));
  if (n === 1) await kv.expire(key, ttlSeconds);
  return n;
}

export type GuardResult =
  | { ok: true; quiet: false }
  | { ok: true; quiet: true; why: string }  // proceed with the SAME reply, but send nothing
  | { ok: false; status: number; message: string; retryAfterSeconds?: number };

/** Paused by the breaker? (Recovers by itself when the pause ends.) */
export async function signupPausedUntil(): Promise<number | null> {
  const kv: any = createKvClient();
  if (!kv) return null;
  const v = Number(await kv.get('signup:paused_until').catch(() => 0)) || 0;
  return v > Date.now() ? v : null;
}

async function tripBreaker(kv: any, policy: SignupPolicy, why: string): Promise<number> {
  const until = Date.now() + policy.breakerPauseMinutes * 60_000;
  await kv.setex('signup:paused_until', policy.breakerPauseMinutes * 60, String(until));
  if ((await bump(kv, 'signup:alert:' + hourKey(), 3700)) === 1) {
    try {
      const { sendOperatorAlertEmail } = await import('@/lib/email');
      const sent = await sendOperatorAlertEmail({ subject: 'Signup paused itself', lines: [
        'The signup circuit breaker tripped: ' + why + '.',
        'New signups are paused until ' + new Date(until).toISOString() + ' and resume by themselves after that.',
        'To stop signups entirely, set ALLOW_MERCHANT_SIGNUP to false. This alert is sent at most once an hour.',
      ] });
      // Not sent? Release the once-an-hour slot so the next trip tries again.
      if (!sent.ok) await kv.del('signup:alert:' + hourKey());
    } catch (err) {
      await kv.del('signup:alert:' + hourKey()).catch(() => null);
      console.error('[signup-guard] breaker alert failed', (err as Error)?.message || err);
    }
  }
  console.error('[signup-guard] BREAKER TRIPPED: ' + why);
  return until;
}

/**
 * Count one signup attempt against every limit. Order matters: a pause
 * in force, then the visible per-IP friction, then the global breaker (so one
 * network cannot trip it for everyone), then the silent per-email/domain.
 */
export async function guardSignupAttempt(input: { ip: string; email: string }): Promise<GuardResult> {
  const kv: any = createKvClient();
  if (!kv) return { ok: false, status: 503, message: 'Signups are unavailable right now. Please try again shortly.' };
  const policy = await signupPolicy();
  const paused = await signupPausedUntil();
  if (paused) return { ok: false, status: 503, message: 'New signups are paused for a short while. Please try again later.', retryAfterSeconds: Math.ceil((paused - Date.now()) / 1000) };

  const ip = input.ip || 'unknown';
  const ipDay = await bump(kv, 'signup:ip:d:' + dayKey() + ':' + ip, 90_000);
  if (ipDay > policy.ipHardPerDay) return { ok: false, status: 429, message: 'Too many signups from your network today. Please try again tomorrow, or email us.' };
  const ipHour = await bump(kv, 'signup:ip:h:' + hourKey() + ':' + ip, 3700);
  // The last attempt is remembered on EVERY attempt, so the first one over
  // the soft limit already has to wait (it slipped through before).
  const lastKey = 'signup:ip:last:' + ip;
  const last = Number(await kv.get(lastKey).catch(() => 0)) || 0;
  const since = (Date.now() - last) / 1000;
  await kv.setex(lastKey, 3700, String(Date.now()));
  if (ipHour > policy.ipSoftPerHour) {
    // Escalating wait between attempts, not a block: 1, 2, 4 ... minutes.
    const wait = Math.min(3600, 60 * 2 ** (ipHour - policy.ipSoftPerHour - 1));
    if (last && since < wait) {
      const left = Math.ceil(wait - since);
      return { ok: false, status: 429, message: 'Lots of signups from your network. Please wait ' + Math.ceil(left / 60) + ' minute' + (left > 60 ? 's' : '') + ' and try again.', retryAfterSeconds: left };
    }
  }

  // The global breaker counts only attempts that got past the per-IP limits:
  // counting first let ONE network hammering the form pause signup for
  // everyone (found while writing the attack proof, 2026-10-01).
  const gh = await bump(kv, 'signup:g:h:' + hourKey(), 3700);
  const gd = await bump(kv, 'signup:g:d:' + dayKey(), 90_000);
  if (gh > policy.globalPerHour || gd > policy.globalPerDay) {
    const until = await tripBreaker(kv, policy, gh > policy.globalPerHour ? gh + ' signups in an hour (limit ' + policy.globalPerHour + ')' : gd + ' signups today (limit ' + policy.globalPerDay + ')');
    return { ok: false, status: 503, message: 'New signups are paused for a short while. Please try again later.', retryAfterSeconds: Math.ceil((until - Date.now()) / 1000) };
  }

  const email = input.email.toLowerCase();
  const domain = emailDomain(email);
  if ((await bump(kv, 'signup:email:d:' + dayKey() + ':' + email, 90_000)) > policy.emailPerDay) return { ok: true, quiet: true, why: 'email daily limit' };
  if (!policy.freemailDomains.includes(domain) && (await bump(kv, 'signup:domain:d:' + dayKey() + ':' + domain, 90_000)) > policy.domainPerDay) {
    return { ok: true, quiet: true, why: 'domain daily limit' };
  }
  return { ok: true, quiet: false };
}

/**
 * May we send a signup email to this address now?
 *   'cooldown'  resend cooldown, doubling per address per day (silent);
 *   'full'      signup's share of today's email is spent (the governed driver,
 *               services/email/governor.ts: ~40% of each provider's DAILY
 *               limit, the rest kept for sign-in codes, orders, winners and
 *               alerts). Told to the visitor as "try again tomorrow".
 */
export async function signupEmailAllowed(email: string): Promise<{ ok: true } | { ok: false; why: 'cooldown' | 'full' }> {
  const kv: any = createKvClient();
  if (!kv) return { ok: false, why: 'full' };
  const policy = await signupPolicy();
  const e = email.toLowerCase();
  const sentToday = Number(await kv.get('signup:sent:d:' + dayKey() + ':' + e).catch(() => 0)) || 0;
  const last = Number(await kv.get('signup:sent:last:' + e).catch(() => 0)) || 0;
  const cooldown = policy.emailResendCooldownSeconds * 2 ** Math.max(0, sentToday - 1);
  if (last && (Date.now() - last) / 1000 < cooldown) return { ok: false, why: 'cooldown' };
  const { emailRoomFor } = await import('@/services/email/factory');
  if (!(await emailRoomFor('signup', e))) return { ok: false, why: 'full' };
  return { ok: true };
}

/** Record a signup email attempt for this address (its resend cooldown). */
export async function noteSignupEmailSent(email: string): Promise<void> {
  const kv: any = createKvClient();
  if (!kv) return;
  const e = email.toLowerCase();
  await bump(kv, 'signup:sent:d:' + dayKey() + ':' + e, 90_000);
  await kv.setex('signup:sent:last:' + e, 90_000, String(Date.now()));
}
