/**
 * BACKFILL public.customers FROM store:users  (H7, migration 00022).
 *
 *   npx tsx scripts/backfill-customer-profiles.ts            # DRY RUN
 *   npx tsx scripts/backfill-customer-profiles.ts --commit
 *
 * Migration 00022 added rewards_balance, email_opt_in, terms_agreed_at and
 * role to public.customers, but an empty column is not a migration: until the
 * existing accounts are copied across, repointing the readers would show every
 * customer a zero balance and "never asked" consent — i.e. it would LOSE the
 * loyalty points people actually hold.
 *
 * WHAT IS NOT COPIED: `password` and `emailVerified`. Those stay in KV by
 * decision, not omission (DEFERRED-6 in ARCHITECTURE.md). `welcomePromoCode`
 * also stays — it is promo bookkeeping, not one of the four concerns 00022
 * split out.
 *
 * IDEMPOTENCE. Re-running must never grant points twice, so this NEVER adds:
 * it copies into a row it just created, and for a row that already exists it
 * copies only the fields still sitting at their column default. A balance that
 * already differs is REPORTED as a divergence and left alone — once the
 * writers repoint, Postgres is the authoritative copy and clobbering it with a
 * stale KV number would be the bug this script exists to prevent.
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

const COMMIT = process.argv.includes('--commit');

/** Roles migration 00022's CHECK constraint accepts. */
const ALLOWED_ROLES = new Set(['customer', 'vip', 'wholesale', 'banned']);

type KvUser = {
  id?: string;
  email?: string;
  role?: string;
  rewards?: unknown;
  emailOptIn?: unknown;
  termsAgreedAt?: unknown;
};

type CustomerRow = {
  id: string;
  email: string;
  rewards_balance: number | null;
  email_opt_in: boolean | null;
  terms_agreed_at: string | null;
  role: string | null;
};

async function main() {
  const { createKvClient, USERS_KEY, safeParseKvItem } = await import('../lib/server-config');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');

  console.log(`\ncustomers profile backfill — ${COMMIT ? 'COMMIT' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(72));

  const kv = createKvClient();
  if (!kv) { console.error('No storage client (KV env missing).'); process.exit(2); }
  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }

  const tenantId = await ensureDefaultTenant();
  console.log('tenant: ' + tenantId);

  const raw = (await kv.hgetall(USERS_KEY)) as Record<string, unknown> | null;
  const fields = Object.entries(raw || {});
  console.log(`store:users fields: ${fields.length}`);

  let created = 0;
  let patched = 0;
  let skipped = 0;
  let diverged = 0;
  let invalid = 0;

  for (const [field, value] of fields) {
    const u = safeParseKvItem<KvUser>(value);
    const email = String(u?.email || '').trim().toLowerCase();
    if (!u || !email) {
      invalid++;
      console.log(`  SKIP  ${field}: unparseable or has no email`);
      continue;
    }

    const rewards = Math.max(0, Math.floor(Number(u.rewards || 0) || 0));
    const optIn = u.emailOptIn === undefined || u.emailOptIn === null ? null : Boolean(u.emailOptIn);
    const terms = typeof u.termsAgreedAt === 'string' && u.termsAgreedAt ? u.termsAgreedAt : null;
    const rawRole = String(u.role || 'customer').trim().toLowerCase();
    // An unrecognised role would fail 00022's CHECK and abort the whole row.
    // Downgrading to 'customer' and saying so loudly beats losing the record.
    const role = ALLOWED_ROLES.has(rawRole) ? rawRole : 'customer';
    if (role !== rawRole) {
      console.log(`  WARN  ${email}: role ${JSON.stringify(rawRole)} is not in 00022's allowed set — storing 'customer'`);
    }

    const existingRows = (await db.select<CustomerRow>('customers', {
      where: { tenant_id: eq(tenantId), email: eq(email) },
      select: ['id', 'email', 'rewards_balance', 'email_opt_in', 'terms_agreed_at', 'role'],
      limit: 1,
    })) as CustomerRow[];
    const existing = existingRows?.[0];

    if (!existing) {
      console.log(
        `  CREATE ${email}  rewards=${rewards} optIn=${optIn} terms=${terms ? terms : 'null'} role=${role}`,
      );
      if (COMMIT) {
        await db.insert('customers', {
          tenant_id: tenantId,
          email,
          rewards_balance: rewards,
          email_opt_in: optIn,
          terms_agreed_at: terms,
          role,
        });
      }
      created++;
      continue;
    }

    // The row is already there. Fill only what is still at its default.
    const patch: Record<string, unknown> = {};
    const pgBalance = Math.max(0, Math.floor(Number(existing.rewards_balance || 0) || 0));
    if (pgBalance === 0 && rewards > 0) patch.rewards_balance = rewards;
    else if (pgBalance !== rewards) {
      diverged++;
      console.log(
        `  DIVERGED ${email}: postgres=${pgBalance} kv=${rewards} — left alone (postgres is authoritative)`,
      );
    }
    if (existing.email_opt_in === null && optIn !== null) patch.email_opt_in = optIn;
    if (!existing.terms_agreed_at && terms) patch.terms_agreed_at = terms;
    if ((existing.role || 'customer') === 'customer' && role !== 'customer') patch.role = role;

    if (Object.keys(patch).length === 0) {
      skipped++;
      console.log(`  OK    ${email}: already carries its profile — nothing to do`);
      continue;
    }
    console.log(`  PATCH ${email}  ${JSON.stringify(patch)}`);
    if (COMMIT) {
      await db.update('customers', { where: { tenant_id: eq(tenantId), id: eq(existing.id) } }, patch, {
        returning: 'default',
      });
    }
    patched++;
  }

  console.log('-'.repeat(72));
  console.log(
    `created=${created} patched=${patched} unchanged=${skipped} diverged=${diverged} invalid=${invalid}`,
  );
  if (!COMMIT) console.log('\nDRY RUN — nothing was written. Re-run with --commit.');
  if (diverged > 0) {
    console.log(
      '\nA divergence is not automatically wrong: after the writers repoint, Postgres\n' +
      'moves and the KV mirror can lag a failed mirror write. Investigate before\n' +
      'assuming data loss — but never "fix" it by copying KV over Postgres.',
    );
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
