/**
 * CUSTOMER PROFILE VERIFICATION (H7, migration 00022).
 *
 *   npm run verify:profile          # against the live Supabase in .env.local
 *
 * "The migration ran" and "the CAS is written correctly" prove nothing. Points
 * are money — app/api/account/redeem-points mints a real fixed-amount promo
 * code against the balance — so a lost update here hands out free store
 * credit. This exercises the REAL adjustRewards against the REAL database and
 * asserts the behaviours money depends on.
 *
 * THE TEST THAT MATTERS is section 4: N genuinely parallel redemptions against
 * ONE balance. The invariant is CONSERVATION —
 *
 *     successes x amount + final balance === starting balance
 *
 * — not "about half succeeded". A lost update breaks conservation loudly
 * (points get spent that never leave the balance) while a retry exhaustion
 * does not, and conflating the two is how a broken CAS passes a sloppy test.
 * Same race class as the H4 inventory oversell, checked the same way.
 *
 * WHAT IT WRITES: rows in public.customers for addresses at @goyunir.invalid
 * (a reserved TLD that can never be a real inbox), deleted on the way out. It
 * never changes a real customer's balance; the one real record is READ only.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const STAMP = Date.now().toString(36);
const testEmail = (n: string) => 'h7-verify-' + STAMP + '-' + n + '@goyunir.invalid';
const created: string[] = [];

async function main() {
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readProfile, adjustRewards, setProfileFields } = await import('../lib/customer-profile');

  const db = getDb();
  if (!db.configured) {
    console.error('No Supabase service credentials — nothing to verify against.');
    process.exit(2);
  }
  const tenantId = await ensureDefaultTenant();

  console.log('\nCustomer profile — the loyalty balance under real concurrent load');
  console.log('='.repeat(72));
  console.log('tenant: ' + tenantId + '\n');

  const balanceOf = async (email: string): Promise<number | null> => {
    const rows = (await db.select<{ rewards_balance: number | null }>('customers', {
      where: { tenant_id: eq(tenantId), email: eq(email) },
      select: ['rewards_balance'],
      limit: 1,
    })) as Array<{ rewards_balance: number | null }>;
    return rows?.[0] ? Math.floor(Number(rows[0].rewards_balance) || 0) : null;
  };

  // ── 1. the backfilled production record reads back ──────────────────────
  console.log('1. The real record the backfill created');
  const real = await readProfile(tenantId, 'goyunir.support@gmail.com');
  check(real !== null, 'the backfilled customer is readable through readProfile');
  check(real?.emailOptIn === true, 'email_opt_in survived as true (not null, not false)', JSON.stringify(real));
  check(
    typeof real?.termsAgreedAt === 'string' && real.termsAgreedAt.startsWith('2026-08-30'),
    'terms_agreed_at kept the ORIGINAL consent date, not the backfill date',
    JSON.stringify(real?.termsAgreedAt),
  );
  check(real?.role === 'customer', 'role came across', JSON.stringify(real?.role));
  check(real?.rewardsBalance === 0, 'balance matches the KV record it was copied from', JSON.stringify(real?.rewardsBalance));

  // ── 2. grant / spend round trip ─────────────────────────────────────────
  console.log('\n2. Grant and spend, end to end');
  const e1 = testEmail('a');
  created.push(e1);
  const granted = await adjustRewards(tenantId, e1, 250);
  check(granted.ok && granted.balance === 250, 'a grant to an unknown email CREATES the record and lands 250', JSON.stringify(granted));
  check((await balanceOf(e1)) === 250, 'and the DATABASE really holds 250, not just the return value', String(await balanceOf(e1)));

  const spent = await adjustRewards(tenantId, e1, -100);
  check(spent.ok && spent.balance === 150, 'spending 100 leaves 150', JSON.stringify(spent));
  check((await balanceOf(e1)) === 150, 'and the database agrees', String(await balanceOf(e1)));

  const over = await adjustRewards(tenantId, e1, -1000);
  check(!over.ok && over.reason === 'insufficient_points', 'overspending is REFUSED', JSON.stringify(over));
  check((await balanceOf(e1)) === 150, 'and the balance is UNCHANGED — no partial spend', String(await balanceOf(e1)));

  const exact = await adjustRewards(tenantId, e1, -150);
  check(exact.ok && exact.balance === 0, 'the whole balance can be spent exactly', JSON.stringify(exact));
  const fromZero = await adjustRewards(tenantId, e1, -1);
  check(!fromZero.ok && fromZero.reason === 'insufficient_points', 'spending from zero is refused', JSON.stringify(fromZero));
  check((await balanceOf(e1)) === 0, 'and zero never goes negative', String(await balanceOf(e1)));

  // A SPEND must never conjure a customer record — that would be a balance
  // invented for an address the store has never granted anything to.
  const ghost = testEmail('ghost');
  const ghostSpend = await adjustRewards(tenantId, ghost, -50);
  check(!ghostSpend.ok && ghostSpend.reason === 'no_customer', 'spending for an unknown email does not create a record', JSON.stringify(ghostSpend));
  check((await balanceOf(ghost)) === null, 'and no row was written for it', JSON.stringify(await balanceOf(ghost)));

  // ── 3. consent and role ─────────────────────────────────────────────────
  console.log('\n3. Consent and role, and partial writes that must not clobber');
  const e2 = testEmail('b');
  created.push(e2);
  const ts = new Date().toISOString();
  check(await setProfileFields(tenantId, e2, { emailOptIn: false, termsAgreedAt: ts }), 'consent write succeeds');
  let p2 = await readProfile(tenantId, e2);
  check(p2?.emailOptIn === false, 'declined consent stores as FALSE, distinct from "never asked"', JSON.stringify(p2?.emailOptIn));
  check(await setProfileFields(tenantId, e2, { role: 'vip' }), 'a role-only write succeeds');
  p2 = await readProfile(tenantId, e2);
  check(p2?.role === 'vip', 'role updated', JSON.stringify(p2?.role));
  check(p2?.emailOptIn === false, 'and the role write did NOT clobber the consent it never saw', JSON.stringify(p2?.emailOptIn));

  const e3 = testEmail('c');
  created.push(e3);
  await adjustRewards(tenantId, e3, 10);
  const p3 = await readProfile(tenantId, e3);
  check(p3?.emailOptIn === null, 'a customer nobody asked has email_opt_in NULL, not false', JSON.stringify(p3?.emailOptIn));

  // ── 4. THE RACE: concurrent redemptions against one balance ─────────────
  console.log('\n4. Concurrent redemptions against ONE balance (the H4 race class)');

  const races = [
    { label: 'ten 100-point redemptions against 500', start: 500, amount: 100, parallel: 10 },
    { label: 'eight full redemptions against 100 (exactly one may win)', start: 100, amount: 100, parallel: 8 },
    { label: 'twenty 25-point redemptions against 250', start: 250, amount: 25, parallel: 20 },
  ];

  for (const race of races) {
    const email = testEmail('race-' + race.start + '-' + race.amount);
    created.push(email);
    const seed = await adjustRewards(tenantId, email, race.start);
    if (!seed.ok) {
      check(false, 'seeding ' + race.label, JSON.stringify(seed));
      continue;
    }

    // Fire them at the same moment. These are real round trips to the real
    // database, so the interleaving is genuine, not simulated.
    const results = await Promise.all(
      Array.from({ length: race.parallel }, () => adjustRewards(tenantId, email, -race.amount)),
    );
    const successes = results.filter((r) => r.ok).length;
    const insufficient = results.filter((r) => !r.ok && r.reason === 'insufficient_points').length;
    const contended = results.filter((r) => !r.ok && r.reason === 'contended').length;
    const errored = results.filter((r) => !r.ok && r.reason === 'error').length;
    const final = await balanceOf(email);
    const maxPossible = Math.floor(race.start / race.amount);

    console.log(
      '\n   ' + race.label + '\n' +
      '   ' + race.parallel + ' parallel | start=' + race.start + ' | spend=' + race.amount + ' each\n' +
      '   -> ok=' + successes + ' insufficient=' + insufficient +
      ' contended=' + contended + ' error=' + errored + ' final=' + final,
    );

    // CONSERVATION is the invariant a lost update breaks: every reported
    // success must be visible in the balance.
    check(
      successes * race.amount + (final ?? -1) === race.start,
      '   conservation: ' + successes + 'x' + race.amount + ' + ' + final + ' === ' + race.start,
      'successes=' + successes + ' final=' + final + ' start=' + race.start,
    );
    check(successes <= maxPossible, '   at most ' + maxPossible + ' redemptions succeeded (no double-spend)', 'successes=' + successes);
    check(successes >= 1, '   at least one redemption got through (not all starved)', 'successes=' + successes);
    check((final ?? -1) >= 0, '   the balance never went negative', String(final));
    check(errored === 0, '   no redemption failed with an unexplained error', 'errors=' + errored);
  }

  // ── 5. concurrent GRANTS must not lose points either ────────────────────
  console.log('\n5. Concurrent grants against one balance (the lost-update mirror image)');
  const eg = testEmail('grants');
  created.push(eg);
  await adjustRewards(tenantId, eg, 1); // create the record first
  const GRANTS = 10;
  const grantResults = await Promise.all(
    Array.from({ length: GRANTS }, () => adjustRewards(tenantId, eg, 10)),
  );
  const grantOk = grantResults.filter((r) => r.ok).length;
  const grantFinal = await balanceOf(eg);
  console.log('   ' + GRANTS + ' parallel +10 grants -> ok=' + grantOk + ' final=' + grantFinal);
  check(
    grantFinal === 1 + grantOk * 10,
    '   every grant that reported success is IN the balance (1 + ' + grantOk + 'x10 === ' + grantFinal + ')',
    'ok=' + grantOk + ' final=' + grantFinal,
  );
  check(grantOk === GRANTS, '   and all ' + GRANTS + ' grants survived the retry budget', 'ok=' + grantOk);

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up test rows...');
  let removed = 0;
  for (const email of created) {
    try {
      await db.remove('customers', { where: { tenant_id: eq(tenantId), email: eq(email) } });
      removed++;
    } catch (err) {
      console.error('  could not delete ' + email + ': ' + ((err as Error)?.message || err));
    }
  }
  const leftovers = (await db.select<{ email: string }>('customers', {
    where: { tenant_id: eq(tenantId), email: eq(created[0]) },
    select: ['email'],
    limit: 1,
  })) as Array<{ email: string }>;
  check(leftovers.length === 0, 'test rows were deleted (' + removed + '/' + created.length + ')');

  console.log('\n' + '='.repeat(72));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
