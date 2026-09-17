/**
 * BACKFILL public.alert_subscribers FROM customer:waitlist  (H8, migration 00023).
 *
 *   npx tsx scripts/backfill-alert-subscribers.ts            # DRY RUN
 *   npx tsx scripts/backfill-alert-subscribers.ts --commit
 *
 * This store's production KV holds ZERO subscribers right now, so on this
 * deployment the script is a no-op that proves the list is empty rather than
 * assuming it. It exists because "there is nothing to migrate" is a claim that
 * should be produced by running something, and because any other deployment of
 * this codebase may well have a real list.
 *
 * WHY NOT waitlist_entries: see supabase/migrations/00023's header. That table
 * is a per-VARIANT restock queue; this data has no variant.
 *
 * IDEMPOTENCE. A re-run must not resurrect someone who has since been removed,
 * nor un-send an announcement. So it only CREATES rows that are absent, and for
 * a row that already exists it merges sources/interests and fills
 * notified_slugs only where Postgres has no entry for that slug — a slug
 * already recorded in Postgres is newer than the KV copy and is left alone.
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

type KvSubscriber = {
  email?: string;
  status?: string;
  sources?: unknown;
  interests?: unknown;
  createdAt?: string;
  updatedAt?: string;
  notifications?: Record<string, string>;
};

const toArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

async function main() {
  const { createKvClient, WAITLIST_KEY, safeParseKvItem } = await import('../lib/server-config');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readSubscriber } = await import('../lib/alert-subscribers');

  console.log(`\nalert_subscribers backfill — ${COMMIT ? 'COMMIT' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(72));

  const kv = createKvClient();
  if (!kv) { console.error('No storage client (KV env missing).'); process.exit(2); }
  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }

  const tenantId = await ensureDefaultTenant();
  console.log('tenant: ' + tenantId);

  const raw = (await kv.hgetall(WAITLIST_KEY)) as Record<string, unknown> | null;
  const fields = Object.entries(raw || {});
  console.log(`customer:waitlist fields: ${fields.length}`);
  if (fields.length === 0) {
    console.log('\nNothing to migrate — the KV drop-alert list is empty.');
  }

  let created = 0;
  let merged = 0;
  let unchanged = 0;
  let invalid = 0;

  for (const [field, value] of fields) {
    const s = safeParseKvItem<KvSubscriber>(value);
    const email = String(s?.email || field || '').trim().toLowerCase();
    if (!s || !email) {
      invalid++;
      console.log(`  SKIP  ${field}: unparseable or has no email`);
      continue;
    }

    const sources = toArray(s.sources);
    const interests = toArray(s.interests);
    const status = s.status === 'unsubscribed' ? 'unsubscribed' : 'active';
    const notified =
      s.notifications && typeof s.notifications === 'object' ? s.notifications : {};

    const existing = await readSubscriber(tenantId, email);

    if (!existing) {
      console.log(
        `  CREATE ${email}  status=${status} sources=${JSON.stringify(sources)} ` +
        `interests=${JSON.stringify(interests)} notified=${Object.keys(notified).length}`,
      );
      if (COMMIT) {
        await db.insert('alert_subscribers', {
          tenant_id: tenantId,
          email,
          status,
          sources,
          interests,
          notified_slugs: notified,
          // Preserve the ORIGINAL signup date. Defaulting to now() would make
          // every subscriber look like they joined on migration day, which is
          // the kind of quiet data loss that only shows up months later in a
          // cohort chart.
          ...(s.createdAt ? { created_at: s.createdAt } : {}),
        });
      }
      created++;
      continue;
    }

    const patch: Record<string, unknown> = {};
    const nextSources = Array.from(new Set([...existing.sources, ...sources]));
    const nextInterests = Array.from(new Set([...existing.interests, ...interests]));
    if (nextSources.length !== existing.sources.length) patch.sources = nextSources;
    if (nextInterests.length !== existing.interests.length) patch.interests = nextInterests;

    // Only slugs Postgres has never heard of. A slug already there was written
    // by the live code and is newer than this KV snapshot.
    const missingSlugs: Record<string, string> = {};
    for (const [slug, at] of Object.entries(notified)) {
      if (!existing.notifiedSlugs[slug]) missingSlugs[slug] = String(at);
    }
    if (Object.keys(missingSlugs).length > 0) {
      patch.notified_slugs = { ...existing.notifiedSlugs, ...missingSlugs };
    }

    if (Object.keys(patch).length === 0) {
      unchanged++;
      console.log(`  OK    ${email}: already present and complete`);
      continue;
    }
    console.log(`  MERGE ${email}  ${JSON.stringify(patch)}`);
    if (COMMIT) {
      await db.update(
        'alert_subscribers',
        { where: { tenant_id: eq(tenantId), email: eq(email) } },
        patch,
        { returning: 'default' },
      );
    }
    merged++;
  }

  console.log('-'.repeat(72));
  console.log(`created=${created} merged=${merged} unchanged=${unchanged} invalid=${invalid}`);
  if (!COMMIT && fields.length > 0) console.log('\nDRY RUN — nothing was written. Re-run with --commit.');
}

main().catch((err) => { console.error(err); process.exit(1); });
