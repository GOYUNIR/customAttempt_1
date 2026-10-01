/**
 * TURNSTILE — server-side verification of the signup widget's token.
 *
 * FAILS CLOSED: no secret, a network error, a non-JSON reply or any refusal
 * means "not verified". A signup without a verified human never proceeds.
 * Checked on every call (Cloudflare docs: turnstile/get-started/server-side):
 *   success === true            (Cloudflare refuses forged, expired and REUSED
 *                                tokens itself: "invalid-input-response",
 *                                "timeout-or-duplicate")
 *   hostname is an expected one (a token solved on another site is refused)
 *   challenge_ts is recent      (5 minutes, Cloudflare's own token lifetime)
 * The visitor's IP is the real one (cf-connecting-ip), sent as remoteip.
 */

export type TurnstileResult = { ok: true } | { ok: false; reason: 'missing' | 'unavailable' | 'rejected' | 'hostname' | 'stale' };

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_AGE_MS = 5 * 60 * 1000;

/** Hosts the signup widget renders on: TURNSTILE_EXPECTED_HOSTNAMES, else the platform root. */
export function expectedTurnstileHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = String(env.TURNSTILE_EXPECTED_HOSTNAMES || env.PLATFORM_ROOT_DOMAIN || '');
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export async function verifyTurnstile(input: {
  token: string; ip?: string | null; secret?: string; expectedHosts?: string[];
  fetchImpl?: typeof fetch; now?: number;
}): Promise<TurnstileResult> {
  const token = String(input.token || '').trim();
  if (!token || token.length > 2048) return { ok: false, reason: 'missing' };
  const secret = input.secret ?? process.env.TURNSTILE_SECRET_KEY ?? '';
  const hosts = input.expectedHosts ?? expectedTurnstileHosts();
  if (!secret || hosts.length === 0) return { ok: false, reason: 'unavailable' };
  const body = new URLSearchParams({ secret, response: token, idempotency_key: crypto.randomUUID() });
  if (input.ip) body.set('remoteip', input.ip);
  let r: any;
  try {
    const res = await (input.fetchImpl || fetch)(VERIFY_URL, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    r = await res.json();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!r || r.success !== true) return { ok: false, reason: 'rejected' };
  if (!hosts.includes(String(r.hostname || '').toLowerCase())) return { ok: false, reason: 'hostname' };
  const ts = Date.parse(String(r.challenge_ts || ''));
  if (!Number.isFinite(ts) || (input.now ?? Date.now()) - ts > MAX_AGE_MS) return { ok: false, reason: 'stale' };
  return { ok: true };
}
