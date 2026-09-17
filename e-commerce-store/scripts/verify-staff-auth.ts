/**
 * STAFF AUTH VERIFICATION (auth phase, migration 00024).
 *
 *   npm run dev            # in another terminal
 *   npm run verify:staff-auth
 *
 * Two things are being proven, and the first matters more than the second.
 *
 * 1. THE MASTER SUPER-ADMIN CAN STILL SIGN IN. Migration 00024 made
 *    public.users authoritative and the sign-in path now reads it instead of
 *    public.profiles. If the backfill missed the master account, nobody can
 *    sign in to anything, ever. That is the one failure this phase must not
 *    cause, so it is checked first and checked directly.
 *
 *    Their password is not known to this script and is not needed: the password
 *    step (verifySuperAdminCredentials) was not changed. What changed is the
 *    IDENTITY lookup that follows it, so that is what is verified.
 *
 * 2. A NON-SUPER-ADMIN STAFF ACCOUNT CAN NOW SIGN IN. Before this phase,
 *    /api/admin/login called verifySuperAdminSignIn, which fails closed for
 *    anyone without is_super_admin — so the entire platform accepted exactly
 *    one staff account. A real Supabase Auth user is created with role
 *    'sales_rep', signed in over HTTP through the real route, and the device
 *    record is inspected to confirm it carries sales_rep and NOT the 'owner'
 *    that the old no-metadata path silently granted.
 *
 * WHAT IT WRITES, and cleans up: one Supabase Auth user and one public.users
 * row for an @goyunir.invalid address, plus whatever session/device records
 * that sign-in produces. All reversible; nothing touches the master account.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
const STAMP = Date.now().toString(36);
const TEST_EMAIL = 'h9-staff-' + STAMP + '@goyunir.invalid';
const TEST_PASSWORD = 'Sv-' + randomBytes(12).toString('hex') + '!A1';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { supabaseAuthFetch, readSupabaseEnv, supabaseAuthConfigured, supabaseAuthMissingReason } =
    await import('../services/config/supabase-client');
  const { createKvClient, ADMIN_DEVICES_KEY, safeParseKvItem } = await import('../lib/server-config');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }
  const { serviceRoleKey } = readSupabaseEnv();
  const kv = createKvClient();

  console.log('\nStaff auth — can the master still sign in, and can anyone else?');
  console.log('='.repeat(74));

  // ── 1. THE LOCKOUT CHECK ────────────────────────────────────────────────
  console.log('\n1. The master super-admin survived the identity-table switch');
  const masters = (await db.select<{ email: string; is_super_admin: boolean | null }>('users', {
    where: { is_super_admin: eq(true) }, select: ['email', 'is_super_admin'], limit: 10,
  })) as Array<{ email: string; is_super_admin: boolean | null }>;
  check(masters.length >= 1, 'public.users holds at least one super-admin', 'rows=' + masters.length);

  for (const m of masters) {
    const identity = await readStaffIdentity(m.email);
    check(identity !== null, '   ' + m.email + ' resolves to a staff identity', 'null — THIS WOULD LOCK THEM OUT');
    check(identity?.role === 'super_admin', '   and resolves as super_admin', JSON.stringify(identity?.role));
    const meta = identity ? deviceMetaFor(identity) : null;
    check(
      meta?.role === 'super_admin' && meta?.superAdmin === true,
      '   and the device it would be issued carries super_admin',
      JSON.stringify(meta),
    );
  }

  // profiles must not have anyone that users does not, or that person is locked out.
  const profiles = (await db.select<{ id: string; email: string | null }>('profiles', {
    select: ['id', 'email'], limit: 200,
  })) as Array<{ id: string; email: string | null }>;
  const userRows = (await db.select<{ id: string }>('users', { select: ['id'], limit: 200 })) as Array<{ id: string }>;
  const userIds = new Set(userRows.map((u) => u.id));
  const stranded = profiles.filter((p) => p.email && !userIds.has(p.id));
  check(
    stranded.length === 0,
    'every profiles account has a users row — nobody was stranded by the backfill',
    'stranded: ' + JSON.stringify(stranded.map((s) => s.email)),
  );

  // ── 2. negative cases ───────────────────────────────────────────────────
  console.log('\n2. Who is NOT staff');
  check((await readStaffIdentity('nobody-' + STAMP + '@goyunir.invalid')) === null,
    'an unknown email is not staff');
  check((await readStaffIdentity('')) === null, 'an empty email is not staff');
  const customerIdentity = await readStaffIdentity('goyunir.support@gmail.com');
  check(customerIdentity === null,
    'a STOREFRONT customer is not staff (they live in customers, not users)',
    JSON.stringify(customerIdentity));

  // ── 3. a real non-super-admin staff account, signing in over HTTP ───────
  console.log('\n3. A sales_rep can sign in — the blocker this phase existed to remove');

  let serverUp = true;
  try {
    const ping = await fetch(BASE + '/api/config-check');
    if (!ping.ok) serverUp = false;
  } catch { serverUp = false; }

  // The password grant needs the ANON key, not the service key. Without it
  // supabaseConfigured() is false, /api/admin/login skips its whole Supabase
  // branch, and EVERY account gets 401 — including the master super-admin,
  // whose only remaining way in is the legacy ADMIN_BASIC_AUTH_PASSWORD.
  //
  // Reported as a blocked check rather than a failure: the code under test is
  // fine, the environment cannot exercise it. A silent skip would be worse —
  // this is exactly the kind of gap that reads as "auth works" right up until
  // nobody can sign in.
  const authReady = supabaseAuthConfigured();
  if (!authReady) {
    console.log('');
    console.log('   BLOCKED — ' + supabaseAuthMissingReason());
    console.log('   The password grant cannot run, so the HTTP sign-in below is skipped.');
    console.log('   This is a DEPLOYMENT gap, not a code failure: without SUPABASE_ANON_KEY');
    console.log('   the Supabase branch of /api/admin/login never executes and the only way');
    console.log('   in is ADMIN_BASIC_AUTH_PASSWORD. Staff invites cannot work either.');
  }

  let authUserId = '';
  try {
    const created = (await supabaseAuthFetch('/admin/users', {
      key: serviceRoleKey, method: 'POST',
      body: { email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true },
    })) as { id?: string } | null;
    authUserId = String(created?.id || '');
    check(Boolean(authUserId), 'a Supabase Auth user can be created for an invitee');

    if (authUserId) {
      await db.insert('users', {
        id: authUserId, email: TEST_EMAIL, role: 'sales_rep', is_super_admin: false,
      }, { returning: 'minimal' });

      const identity = await readStaffIdentity(TEST_EMAIL);
      check(identity?.role === 'sales_rep', 'and resolves as sales_rep', JSON.stringify(identity?.role));
      check(identity?.isSuperAdmin === false, 'and is NOT a super-admin', JSON.stringify(identity?.isSuperAdmin));
      const meta = identity ? deviceMetaFor(identity) : null;
      check(meta?.role === 'sales_rep' && meta?.superAdmin === false,
        'the device it gets carries sales_rep, NOT the "owner" the old path granted',
        JSON.stringify(meta));

      if (!serverUp || !authReady) {
        if (!serverUp) console.log('   (skipping the HTTP sign-in — no dev server on ' + BASE + ')');
      } else {
        const res = await fetch(BASE + '/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', origin: BASE },
          body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
        });
        const body = await res.json().catch(() => ({}));
        check(res.status === 200 && body?.ok === true,
          'POST /api/admin/login ACCEPTS the sales_rep (was 401 for every non-super-admin)',
          'status=' + res.status + ' body=' + JSON.stringify(body));

        // When no email provider gates it, the device cookie is issued straight
        // away — inspect what role it actually carries.
        const setCookie = res.headers.get('set-cookie') || '';
        const deviceToken = /goyunir_admin_device=([^;]+)/.exec(setCookie)?.[1];
        if (deviceToken && kv) {
          const raw = await kv.hget(ADMIN_DEVICES_KEY, deviceToken);
          const record = safeParseKvItem<any>(raw);
          check(record?.role === 'sales_rep',
            'and the issued DEVICE records role=sales_rep',
            JSON.stringify(record));
          check(record?.superAdmin !== true,
            'and is not flagged super-admin',
            JSON.stringify(record?.superAdmin));
          await kv.hdel(ADMIN_DEVICES_KEY, deviceToken).catch(() => {});
        } else if (body?.needs2fa) {
          console.log('   (2FA is enabled, so no device cookie yet — role is stamped at verify-confirm)');
        }

        const bad = await fetch(BASE + '/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', origin: BASE },
          body: JSON.stringify({ email: TEST_EMAIL, password: 'wrong-' + TEST_PASSWORD }),
        });
        check(bad.status === 401, 'a wrong password is still refused', 'status=' + bad.status);
      }
    }
  } finally {
    // ── cleanup ───────────────────────────────────────────────────────────
    console.log('\nCleaning up...');
    try { await db.remove('users', { where: { email: eq(TEST_EMAIL) } }); } catch { /* ignore */ }
    if (authUserId) {
      try {
        await supabaseAuthFetch('/admin/users/' + authUserId, { key: serviceRoleKey, method: 'DELETE' });
      } catch (err) {
        console.error('  could not delete the test auth user: ' + ((err as Error)?.message || err));
      }
    }
    const left = (await db.select<{ id: string }>('users', {
      where: { email: eq(TEST_EMAIL) }, select: ['id'], limit: 1,
    })) as Array<{ id: string }>;
    check(left.length === 0, 'the test staff row is gone');
    check((await readStaffIdentity(TEST_EMAIL)) === null, 'and it no longer resolves as staff');
  }

  console.log('\n' + '='.repeat(74));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
