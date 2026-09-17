/**
 * CUSTOMER PROFILE ROUND TRIP, OVER HTTP (H7, migration 00022).
 *
 *   npm run dev                       # in another terminal
 *   npm run verify:profile-roundtrip  # optionally BASE_URL=http://localhost:3000
 *
 * scripts/verify-customer-profile.ts proves the compare-and-swap in
 * lib/customer-profile.ts. This proves the ROUTES actually go through it —
 * that login, /auth/me, /account/lookup and /account/redeem-points read and
 * write public.customers and not the `store:users` KV blob they used to.
 * A library that is correct behind routes that never call it is worth nothing.
 *
 * THE MONEY TEST is section 6: several redemptions fired at the SAME balance
 * through the real HTTP handler, with the real session, the real distributed
 * lock and the real CAS. Exactly one credit code may be minted. The old code
 * minted the promo BEFORE deducting, so any interleaving there handed out free
 * store credit; this asserts on the number of REWARD- codes that actually
 * exist in promo:codes afterwards, not on what the responses claimed.
 *
 * WHAT IT WRITES, and cleans up: one store:users record and one customers row
 * for an @goyunir.invalid address (a reserved TLD that can never be a real
 * inbox), the session keys it logs in with, and any promo codes it mints.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';

function loadEnv() {
  const p = join(process.cwd(), '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();
process.env.USE_POSTGRES_PRIMARY = 'true';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const PASSWORD = 'H7-verify-' + randomBytes(6).toString('hex');
const STAMP = Date.now().toString(36);
const EMAIL = 'h7-roundtrip-' + STAMP + '@goyunir.invalid';
const USER_ID = 'usr_h7v_' + STAMP;

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

type Resp = { status: number; body: any; cookie: string };

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Resp> {
  // Origin is sent because middleware.ts refuses cookie-authenticated writes
  // without one (CSRF). A browser always sends it; omitting it here would be
  // testing a request no real client makes, and the 403 that came back the
  // first time was the gate working, not a bug.
  const headers: Record<string, string> = { 'Content-Type': 'application/json', origin: BASE };
  if (init.cookie) headers.cookie = init.cookie;
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  const setCookie = res.headers.get('set-cookie') || '';
  const token = /goyunir_session=([^;]+)/.exec(setCookie);
  return { status: res.status, body, cookie: token ? 'goyunir_session=' + token[1] : '' };
}

async function main() {
  const { createKvClient, USERS_KEY, PROMO_CODES_KEY, safeParseKvItem } = await import('../lib/server-config');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { grantWelcomeRewards, WELCOME_POINTS } = await import('../lib/customer-rewards');

  const kv = createKvClient();
  if (!kv) { console.error('No KV client.'); process.exit(2); }
  const db = getDb();
  if (!db.configured) { console.error('No Supabase credentials.'); process.exit(2); }
  const tenantId = await ensureDefaultTenant();

  // Is the server up? A round trip against a dead server is not a pass.
  try {
    const ping = await call('/api/auth/me');
    if (ping.status >= 500) throw new Error('status ' + ping.status);
  } catch (err) {
    console.error('Cannot reach ' + BASE + ' — start `npm run dev` first. (' + ((err as Error).message) + ')');
    process.exit(2);
  }

  console.log('\nCustomer profile round trip — through the real HTTP routes');
  console.log('='.repeat(72));
  console.log('base:   ' + BASE);
  console.log('tenant: ' + tenantId);
  console.log('email:  ' + EMAIL + '\n');

  const pgBalance = async (): Promise<number | null> => {
    const rows = (await db.select<{ rewards_balance: number | null }>('customers', {
      where: { tenant_id: eq(tenantId), email: eq(EMAIL) },
      select: ['rewards_balance'], limit: 1,
    })) as Array<{ rewards_balance: number | null }>;
    return rows?.[0] ? Math.floor(Number(rows[0].rewards_balance) || 0) : null;
  };
  const kvRewards = async (): Promise<number | null> => {
    const raw = await kv.hget(USERS_KEY, USER_ID);
    const u = safeParseKvItem<any>(raw);
    return u ? Math.floor(Number(u.rewards || 0)) : null;
  };
  const setPgBalance = async (value: number) => {
    await db.update('customers', { where: { tenant_id: eq(tenantId), email: eq(EMAIL) } }, { rewards_balance: value }, { returning: 'default' });
  };
  // Both kinds this run can create. The welcome grant in section 2 mints a
  // WELCOME- code as well as the REWARD- codes redemption mints; an earlier
  // version only cleaned up the latter and left welcome codes behind in the
  // live promo table. Both share the seed derived from the test address, which
  // no real customer can hold.
  const seedOf = (email: string) => email.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase();
  const mintedCodes = async (): Promise<string[]> => {
    const all = (await kv.hgetall(PROMO_CODES_KEY)) || {};
    const seed = seedOf(EMAIL);
    return Object.keys(all).filter((c) => c.startsWith('REWARD-' + seed + '-'));
  };
  const allTestCodes = async (): Promise<string[]> => {
    const all = (await kv.hgetall(PROMO_CODES_KEY)) || {};
    const seed = seedOf(EMAIL);
    return Object.keys(all).filter((c) => c.startsWith('REWARD-' + seed + '-') || c.startsWith('WELCOME-' + seed + '-'));
  };

  const sessions: string[] = [];
  const track = (r: Resp) => { if (r.cookie) sessions.push(r.cookie.split('=')[1]); return r; };

  // ── 0. seed the account the way signup would ────────────────────────────
  const salt = randomBytes(16).toString('hex');
  await kv.hset(USERS_KEY, {
    [USER_ID]: JSON.stringify({
      id: USER_ID,
      email: EMAIL,
      password: salt + ':' + hashPassword(PASSWORD, salt),
      role: 'customer',
      emailVerified: false,
      rewards: 0,
      emailOptIn: true,
      termsAgreedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }),
  });

  // ── 1. login with no customer record yet ────────────────────────────────
  console.log('1. Login before any points exist');
  const login1 = track(await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) }));
  check(login1.status === 200, 'login succeeds (password still verified from KV — DEFERRED-6)', JSON.stringify(login1.body));
  check(login1.body?.user?.rewards === 0, 'and reports 0 points, because no customer record exists yet', JSON.stringify(login1.body?.user));
  check((await pgBalance()) === null, 'login did not invent a customer row', JSON.stringify(await pgBalance()));

  // ── 2. the welcome grant writes Postgres, and mirrors to KV ─────────────
  console.log('\n2. The welcome grant');
  const rawUser = safeParseKvItem<any>(await kv.hget(USERS_KEY, USER_ID));
  const grant = await grantWelcomeRewards(kv, rawUser, EMAIL);
  check(grant.rewardsGranted === true, 'grantWelcomeRewards reports the points actually landed', JSON.stringify(grant.rewardsGranted));
  check((await pgBalance()) === WELCOME_POINTS, 'public.customers holds ' + WELCOME_POINTS, String(await pgBalance()));
  check((await kvRewards()) === WELCOME_POINTS, 'and the KV display mirror agrees (the emails still read it)', String(await kvRewards()));

  // ── 3. /auth/me reads the authoritative balance ─────────────────────────
  console.log('\n3. /api/auth/me');
  const me1 = await call('/api/auth/me', { cookie: login1.cookie });
  check(me1.body?.user?.rewards === WELCOME_POINTS,
    '/auth/me shows ' + WELCOME_POINTS + ' from a session minted when the balance was 0 — it re-read Postgres',
    JSON.stringify(me1.body?.user));

  // Prove it is really reading through, not echoing the session: move the
  // balance behind the route's back and ask again.
  await setPgBalance(137);
  const me2 = await call('/api/auth/me', { cookie: login1.cookie });
  check(me2.body?.user?.rewards === 137, 'changing the row behind its back changes what /auth/me returns', JSON.stringify(me2.body?.user));
  await setPgBalance(WELCOME_POINTS);

  // ── 4. /account/lookup ──────────────────────────────────────────────────
  console.log('\n4. /api/account/lookup');
  const look = await call('/api/account/lookup', { method: 'POST', cookie: login1.cookie, body: JSON.stringify({ email: EMAIL }) });
  check(look.status === 200, 'lookup responds 200', JSON.stringify(look.body).slice(0, 200));
  check(look.body?.rewardsBalance === WELCOME_POINTS, 'and carries the authoritative balance', JSON.stringify(look.body?.rewardsBalance));
  check(look.body?.role === 'customer', 'and the role from public.customers', JSON.stringify(look.body?.role));

  // ── 5. a single redemption, end to end ──────────────────────────────────
  console.log('\n5. One redemption through the real route');
  const redeem = await call('/api/account/redeem-points', { method: 'POST', cookie: login1.cookie, body: JSON.stringify({ points: 100 }) });
  check(redeem.status === 200, 'redemption succeeds', JSON.stringify(redeem.body));
  check(typeof redeem.body?.code === 'string' && redeem.body.code.startsWith('REWARD-'), 'a credit code was minted', JSON.stringify(redeem.body?.code));
  check(redeem.body?.remainingPoints === WELCOME_POINTS - 100, 'it reports the new balance', JSON.stringify(redeem.body?.remainingPoints));
  check((await pgBalance()) === WELCOME_POINTS - 100, 'public.customers really decremented', String(await pgBalance()));
  check((await kvRewards()) === WELCOME_POINTS - 100, 'and the KV mirror followed', String(await kvRewards()));
  const meAfter = await call('/api/auth/me', { cookie: login1.cookie });
  check(meAfter.body?.user?.rewards === WELCOME_POINTS - 100, '/auth/me shows the spend', JSON.stringify(meAfter.body?.user?.rewards));

  // ── 6. THE MONEY TEST: parallel redemptions of the same balance ─────────
  console.log('\n6. Parallel redemptions of ONE balance, through the route');
  const codesBefore = (await mintedCodes()).length;
  await setPgBalance(100);
  const PARALLEL = 6;
  const attempts = await Promise.all(
    Array.from({ length: PARALLEL }, () =>
      call('/api/account/redeem-points', { method: 'POST', cookie: login1.cookie, body: JSON.stringify({ points: 100 }) })),
  );
  const ok = attempts.filter((a) => a.status === 200);
  const statuses = attempts.map((a) => a.status).sort().join(',');
  const finalPg = await pgBalance();
  const codesAfter = (await mintedCodes()).length;
  const newCodes = codesAfter - codesBefore;
  console.log('   ' + PARALLEL + ' parallel redemptions of 100 against a balance of 100');
  console.log('   -> statuses=' + statuses + ' balance=' + finalPg + ' new credit codes=' + newCodes);

  check(ok.length === 1, '   exactly ONE redemption returned 200', 'ok=' + ok.length + ' statuses=' + statuses);
  check(newCodes === 1, '   exactly ONE credit code exists in promo:codes — no free credit was minted', 'new=' + newCodes);
  check(finalPg === 0, '   the balance is 0, spent exactly once', String(finalPg));
  check((await kvRewards()) === 0, '   and the KV mirror agrees', String(await kvRewards()));
  check(
    attempts.every((a) => a.status === 200 || a.status === 400 || a.status === 409 || a.status === 429),
    '   every loser was refused with a real reason, none 500ed',
    statuses,
  );

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up...');
  const { sessionKey } = await import('../lib/redis-keys');
  for (const token of sessions) { try { await kv.del(sessionKey(token)); } catch {} }
  for (const code of await allTestCodes()) { try { await kv.hdel(PROMO_CODES_KEY, code); } catch {} }
  try { await kv.hdel(USERS_KEY, USER_ID); } catch {}
  try { await db.remove('customers', { where: { tenant_id: eq(tenantId), email: eq(EMAIL) } }); } catch {}

  check((await kvRewards()) === null, 'the test store:users record is gone');
  check((await pgBalance()) === null, 'the test customers row is gone');
  check((await allTestCodes()).length === 0, 'every promo code it minted is gone — welcome codes included');

  console.log('\n' + '='.repeat(72));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
