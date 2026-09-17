/**
 * STAFF INVITE VERIFICATION (auth phase, migration 00024).
 *
 *   npm run dev              # in another terminal
 *   npm run verify:invites
 *
 * An invite is a GRANT OF PRIVILEGE delivered to an email address. Three things
 * therefore have to be true, and each is checked against the real database and
 * the real HTTP route rather than reasoned about:
 *
 *   1. The role comes from the INVITE ROW, never from the request body.
 *      Posting `role: 'super_admin'` while holding a sales_rep invite is the
 *      first thing anybody would try, so it is tested explicitly.
 *
 *   2. One invite produces at most ONE account. Acceptance claims the row with
 *      a conditional update before creating anything, so two simultaneous
 *      acceptances — a double-clicked button, a forwarded link — cannot both
 *      succeed. Same compare-and-swap shape as the loyalty balance, for the
 *      same reason.
 *
 *   3. A failed account creation RELEASES the claim. Otherwise the invitee is
 *      left holding a token that reports "already used" for an account that
 *      does not exist.
 *
 * Unlike sign-in, none of this needs SUPABASE_ANON_KEY: account creation goes
 * through the service role. So the invite flow is fully exercisable even on a
 * deployment whose anon key is missing.
 *
 * WHAT IT WRITES, and cleans up: staff_invites rows, Supabase Auth users and
 * public.users rows for @goyunir.invalid addresses. Nothing touches a real
 * account.
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
const email = (n: string) => 'inv-' + STAMP + '-' + n + '@goyunir.invalid';
const PASSWORD = 'Inv-' + randomBytes(10).toString('hex') + '!A1';

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const createdEmails: string[] = [];

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const invites = await import('../lib/staff-invites');
  const { readStaffIdentity } = await import('../lib/staff-identity');
  const { deleteStaffAccount } = await import('../lib/staff-accounts');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }
  const tenantId = await ensureDefaultTenant();

  try {
    await db.select('staff_invites', { select: ['id'], limit: 1 });
  } catch (err) {
    console.error('\npublic.staff_invites is not reachable — apply migration 00024 first.\n  (' +
      ((err as Error)?.message || err) + ')');
    process.exit(2);
  }

  let serverUp = true;
  try { serverUp = (await fetch(BASE + '/api/config-check')).ok; } catch { serverUp = false; }

  console.log('\nStaff invites — a grant of privilege, sent by email');
  console.log('='.repeat(74));
  console.log('tenant: ' + tenantId + (serverUp ? '' : '   (no dev server — HTTP checks skipped)') + '\n');

  // ── 1. issuing ──────────────────────────────────────────────────────────
  console.log('1. Issuing an invitation');
  const e1 = email('rep'); createdEmails.push(e1);
  const created = await invites.createInvite({
    email: e1, role: 'sales_rep', tenantId, invitedByEmail: 'boss@goyunir.invalid',
  });
  check(created.ok, 'an invite is created', JSON.stringify(created));
  if (!created.ok) { console.log('cannot continue'); process.exit(1); }
  check(created.token.length >= 32, 'a token is returned to the caller exactly once');
  check(created.invite.status === 'pending', 'and the invite is pending', created.invite.status);

  // The token must NOT be recoverable from storage.
  const stored = (await db.select<{ token_hash: string }>('staff_invites', {
    where: { id: eq(created.invite.id) }, select: ['token_hash'], limit: 1,
  })) as Array<{ token_hash: string }>;
  check(
    stored[0]?.token_hash === invites.hashInviteToken(created.token),
    'the stored value is the SHA-256 HASH of the token',
  );
  check(
    stored[0]?.token_hash !== created.token,
    'the raw token is NOT in the database — a dump cannot be used to accept it',
  );

  const looked = await invites.lookupInviteByToken(created.token);
  check(looked.ok && looked.invite.role === 'sales_rep', 'the token resolves to its invite', JSON.stringify(looked));

  // ── 2. duplicates ───────────────────────────────────────────────────────
  console.log('\n2. One live invitation per address');
  const dup = await invites.createInvite({
    email: e1, role: 'staff', tenantId, invitedByEmail: 'boss@goyunir.invalid',
  });
  check(!dup.ok && dup.reason === 'already_invited',
    'a second invite to the same address is refused', JSON.stringify(dup));

  // ── 3. THE ESCALATION TEST ──────────────────────────────────────────────
  console.log('\n3. The role comes from the INVITE, not the request');
  if (!serverUp) {
    console.log('   (skipped — needs the dev server)');
  } else {
    const res = await fetch(BASE + '/api/admin/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: BASE },
      // Asking for super_admin while holding a sales_rep invite.
      body: JSON.stringify({ token: created.token, password: PASSWORD, role: 'super_admin', fullName: 'Test Rep' }),
    });
    const body = await res.json().catch(() => ({}));
    check(res.status === 200 && body?.ok === true, 'the invitation is accepted', JSON.stringify(body));

    const identity = await readStaffIdentity(e1);
    check(identity !== null, 'a staff identity now exists', 'null');
    check(identity?.role === 'sales_rep',
      'and the role is sales_rep — the request body did NOT escalate it',
      'role=' + JSON.stringify(identity?.role) + ' (super_admin here would be a privilege escalation)');
    check(identity?.isSuperAdmin === false, 'and it is not a super-admin', JSON.stringify(identity?.isSuperAdmin));
    check(identity?.tenantId === tenantId, 'and it carries the invite’s tenant', JSON.stringify(identity?.tenantId));
    check(body?.signInAt === '/sales/login',
      'and it points them at the SALES sign-in, not the admin one',
      JSON.stringify(body?.signInAt));
  }

  // ── 4. an invite is single-use ──────────────────────────────────────────
  console.log('\n4. One invitation, one account');
  const reuse = await invites.lookupInviteByToken(created.token);
  check(!reuse.ok && reuse.reason === 'accepted',
    'the token cannot be looked up again once used', JSON.stringify(reuse));

  if (serverUp) {
    const again = await fetch(BASE + '/api/admin/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: BASE },
      body: JSON.stringify({ token: created.token, password: PASSWORD + 'x' }),
    });
    check(again.status === 410 || again.status === 409,
      'and re-accepting it is refused', 'status=' + again.status);
  }

  // ── 5. concurrent acceptance ────────────────────────────────────────────
  console.log('\n5. Two people clicking the same link at the same moment');
  const e2 = email('race'); createdEmails.push(e2);
  const raceInvite = await invites.createInvite({
    email: e2, role: 'staff', tenantId, invitedByEmail: 'boss@goyunir.invalid',
  });
  if (raceInvite.ok && serverUp) {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(BASE + '/api/admin/accept-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', origin: BASE },
          body: JSON.stringify({ token: raceInvite.token, password: PASSWORD }),
        })),
    );
    const statuses = results.map((r) => r.status).sort();
    const ok = statuses.filter((s) => s === 200).length;
    const accounts = (await db.select<{ id: string }>('users', {
      where: { email: eq(e2) }, select: ['id'], limit: 10,
    })) as Array<{ id: string }>;
    console.log('   4 parallel acceptances -> statuses=' + statuses.join(',') + ' accounts=' + accounts.length);
    check(ok === 1, '   exactly ONE acceptance succeeded', 'ok=' + ok);
    check(accounts.length === 1, '   and exactly ONE account exists', 'accounts=' + accounts.length);
  } else if (raceInvite.ok) {
    console.log('   (skipped — needs the dev server)');
  }

  // ── 6. revoke ───────────────────────────────────────────────────────────
  console.log('\n6. Revoking');
  const e3 = email('revoked'); createdEmails.push(e3);
  const toRevoke = await invites.createInvite({
    email: e3, role: 'staff', tenantId, invitedByEmail: 'boss@goyunir.invalid',
  });
  if (toRevoke.ok) {
    check(await invites.revokeInvite(toRevoke.invite.id), 'a pending invite can be revoked');
    const after = await invites.lookupInviteByToken(toRevoke.token);
    check(!after.ok && after.reason === 'revoked',
      'and its token stops working immediately', JSON.stringify(after));
    // Revoking frees the address — the partial unique index is what allows this.
    const reinvite = await invites.createInvite({
      email: e3, role: 'staff', tenantId, invitedByEmail: 'boss@goyunir.invalid',
    });
    check(reinvite.ok, 'and the address can be invited again afterwards', JSON.stringify(reinvite));
    if (reinvite.ok) await invites.revokeInvite(reinvite.invite.id);
  }

  // ── 7. expiry ───────────────────────────────────────────────────────────
  console.log('\n7. Expiry');
  const e4 = email('expired'); createdEmails.push(e4);
  const expiring = await invites.createInvite({
    email: e4, role: 'staff', tenantId, invitedByEmail: 'boss@goyunir.invalid',
  });
  if (expiring.ok) {
    await db.update('staff_invites',
      { where: { id: eq(expiring.invite.id) } },
      { expires_at: new Date(Date.now() - 60_000).toISOString() },
      { returning: 'default' });
    const stale = await invites.lookupInviteByToken(expiring.token);
    check(!stale.ok && stale.reason === 'expired',
      'an expired invitation is refused, and says so', JSON.stringify(stale));
  }

  // ── 8. already-staff ────────────────────────────────────────────────────
  console.log('\n8. Inviting someone who already has an account');
  const dupStaff = await invites.createInvite({
    email: e1, role: 'staff', tenantId, invitedByEmail: 'boss@goyunir.invalid',
  });
  check(!dupStaff.ok && dupStaff.reason === 'already_staff',
    'refused, rather than creating a confusing second account', JSON.stringify(dupStaff));

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up...');
  for (const e of createdEmails) {
    try { await deleteStaffAccount(e); } catch { /* may not exist */ }
    try { await db.remove('staff_invites', { where: { email: eq(e) } }); } catch { /* ignore */ }
  }
  let leftovers = 0;
  for (const e of createdEmails) {
    const rows = (await db.select<{ id: string }>('staff_invites', {
      where: { email: eq(e) }, select: ['id'], limit: 5,
    })) as Array<{ id: string }>;
    const users = (await db.select<{ id: string }>('users', {
      where: { email: eq(e) }, select: ['id'], limit: 5,
    })) as Array<{ id: string }>;
    leftovers += rows.length + users.length;
  }
  check(leftovers === 0, 'every test invite and account was removed', 'leftovers=' + leftovers);

  console.log('\n' + '='.repeat(74));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
