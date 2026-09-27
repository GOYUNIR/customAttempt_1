/**
 * PLATFORM SUPPORT -> MERCHANT DASHBOARD HANDOFF.
 *
 * A sales/support person starts a support session on the sales (or admin)
 * host, but the merchant dashboard lives on app.<root>, and a browser will not
 * carry a cookie from one host to the other. So the start of impersonation
 * returns a ONE-TIME code, and app.<root> exchanges it for the session cookie.
 *
 *  - the code is 32 random bytes; only its hash is stored, next to the session
 *    token it stands for, for HANDOFF_TTL_SECONDS;
 *  - it travels in the URL FRAGMENT (#...), which browsers never send to a
 *    server or in a Referer header;
 *  - it is single-use: redeeming claims a "used" marker with setIfAbsent (one
 *    atomic INSERT on the store's primary key), so of two redemptions exactly
 *    one wins;
 *  - redeeming grants nothing by itself: the session it hands over is still
 *    re-checked by lib/merchant-session.ts on every call (role still held,
 *    store still assigned).
 */
import { createHash, randomBytes } from 'crypto';

export const HANDOFF_TTL_SECONDS = 120;
const KEY = 'merchant_support_handoff:';
const USED = 'merchant_support_handoff_used:';

const hashOf = (code: string) => createHash('sha256').update(code).digest('hex');

type Kv = {
  get(key: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  setIfAbsent?: (key: string, value: string, ttlSeconds: number) => Promise<boolean>;
};

/** Store a code for this session token; returns the code, or null if the store cannot do it atomically. */
export async function createSupportHandoff(kv: Kv, token: string, tenantId: string): Promise<string | null> {
  if (typeof kv.setIfAbsent !== 'function') return null;
  const code = randomBytes(32).toString('hex');
  const payload = JSON.stringify({ token, tenantId, expiresAt: Date.now() + HANDOFF_TTL_SECONDS * 1000 });
  return (await kv.setIfAbsent(KEY + hashOf(code), payload, HANDOFF_TTL_SECONDS)) ? code : null;
}

/** Exchange a code for its session token, once. Null for unknown, expired or already used. */
export async function redeemSupportHandoff(kv: Kv, code: string): Promise<{ token: string; tenantId: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(String(code || '')) || typeof kv.setIfAbsent !== 'function') return null;
  const h = hashOf(code);
  const raw = await kv.get(KEY + h).catch(() => null);
  if (!raw) return null;
  let parsed: any = raw;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return null; } }
  if (!parsed?.token || !parsed?.tenantId || !(Number(parsed.expiresAt) > Date.now())) return null;
  // The single-use claim: only the first redemption inserts the marker.
  if (!(await kv.setIfAbsent(USED + h, '1', HANDOFF_TTL_SECONDS * 5).catch(() => false))) return null;
  await kv.del(KEY + h).catch(() => 0);
  return { token: String(parsed.token), tenantId: String(parsed.tenantId) };
}

/** Where the support person's browser goes next: the merchant host's handoff page. */
export function supportHandoffUrl(code: string, rootDomain: string | null | undefined): string {
  const root = String(rootDomain || '').trim().toLowerCase().replace(/\.$/, '');
  return (root ? 'https://app.' + root : '') + '/app/support#' + code;
}
