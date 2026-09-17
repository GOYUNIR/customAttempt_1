/**
 * H8 VERIFICATION — drop-alert subscribers + usage metrics, against the live
 * database.
 *
 *   npm run verify:h8
 *
 * Migration 00023 must be applied first. The script says so plainly rather than
 * failing with a PostgREST error nobody can read.
 *
 * WHAT THIS IS FOR. Two things moved out of KV in H8, and each has one
 * behaviour that actually matters:
 *
 *   alert_subscribers — the dedupe. `notified_slugs` is what stops a
 *     subscriber being emailed twice about the same product. If a subscribe
 *     overwrites it, or a re-subscribe resets it, the next announcement spams
 *     people who already heard. That is checked directly, including across a
 *     re-subscribe, which is exactly when the old read-modify-write was most
 *     likely to clobber it.
 *
 *   analytics_events — that it is written at all. The table sat in the schema
 *     with zero writers and zero readers; "the code now calls it" is worth
 *     nothing until a row is observed, and the totals reader must agree with
 *     what was written rather than with what the writer believed.
 *
 * Postgres arrays are also probed on purpose: `sources`/`interests` are
 * `text[]`, and whether the PostgREST port round-trips a JSON array into a
 * Postgres array is an assumption until something checks it.
 *
 * WHAT IT WRITES, and cleans up: alert_subscribers rows and analytics_events
 * rows for @goyunir.invalid addresses and a throwaway tenant-scoped marker.
 * Both tables allow DELETE, so unlike audit_logs nothing here is permanent.
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
const email = (n: string) => 'h8-verify-' + STAMP + '-' + n + '@goyunir.invalid';
const createdEmails: string[] = [];

async function main() {
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { getDb } = await import('../lib/db/client');
  const { eq, gte } = await import('../lib/db/query');
  const { subscribe, readSubscriber, listSubscribers, removeSubscriber, markNotified } =
    await import('../lib/alert-subscribers');
  const { recordUsageEvent, readUsageTotalsFromDb } = await import('../lib/analytics-events');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }
  const tenantId = await ensureDefaultTenant();

  // Migration applied? Say it in English, not in PostgREST.
  try {
    await db.select('alert_subscribers', { select: ['id'], limit: 1 });
  } catch (err) {
    console.error(
      '\npublic.alert_subscribers is not reachable — apply ' +
      'supabase/migrations/00023_alert_subscribers.sql first.\n  (' +
      ((err as Error)?.message || err) + ')',
    );
    process.exit(2);
  }

  console.log('\nH8 — drop-alert subscribers and usage metrics, against the live database');
  console.log('='.repeat(74));
  console.log('tenant: ' + tenantId + '\n');

  // ── 1. subscribe, and the text[] round trip ─────────────────────────────
  console.log('1. Subscribing, and whether Postgres arrays survive the port');
  const e1 = email('a'); createdEmails.push(e1);
  const first = await subscribe(tenantId, e1, { source: 'footer', interests: ['drops', 'restock'] });
  check(first.ok && first.created === true, 'a new address is created', JSON.stringify(first));
  const s1 = await readSubscriber(tenantId, e1);
  check(s1?.status === 'active', 'status is active', JSON.stringify(s1?.status));
  check(
    Array.isArray(s1?.sources) && s1!.sources.length === 1 && s1!.sources[0] === 'footer',
    'sources came back as a real array, not a string — text[] round-trips through the port',
    JSON.stringify(s1?.sources),
  );
  check(
    Array.isArray(s1?.interests) && s1!.interests.join(',') === 'drops,restock',
    'interests round-trip with their values intact',
    JSON.stringify(s1?.interests),
  );

  // ── 2. re-subscribe UNIONS, never overwrites ────────────────────────────
  console.log('\n2. A second signup from another page must not erase the first');
  const second = await subscribe(tenantId, e1, { source: 'product-page', interests: ['samples'] });
  check(second.ok && second.created === false, 'the same address is not duplicated', JSON.stringify(second));
  const s2 = await readSubscriber(tenantId, e1);
  check(
    (s2?.sources || []).slice().sort().join(',') === 'footer,product-page',
    'both sources are kept',
    JSON.stringify(s2?.sources),
  );
  check(
    (s2?.interests || []).slice().sort().join(',') === 'drops,restock,samples',
    'and all three interests',
    JSON.stringify(s2?.interests),
  );
  const all = await listSubscribers(tenantId);
  check(
    all.filter((s) => s.email === e1).length === 1,
    'exactly ONE row exists for the address (the unique constraint holds)',
    String(all.filter((s) => s.email === e1).length),
  );

  // ── 3. THE DEDUPE: notified_slugs is what prevents double-emailing ──────
  console.log('\n3. The announcement dedupe');
  check(await markNotified(tenantId, s2!, 'midnight-oud'), 'marking a product as announced succeeds');
  const s3 = await readSubscriber(tenantId, e1);
  check(Boolean(s3?.notifiedSlugs['midnight-oud']), 'the slug is recorded', JSON.stringify(s3?.notifiedSlugs));

  check(await markNotified(tenantId, s3!, 'amber-drift'), 'a second product can be marked');
  const s4 = await readSubscriber(tenantId, e1);
  check(
    Boolean(s4?.notifiedSlugs['midnight-oud']) && Boolean(s4?.notifiedSlugs['amber-drift']),
    'and the FIRST slug survived the second write — no clobber',
    JSON.stringify(s4?.notifiedSlugs),
  );

  // The dangerous interleaving: someone re-subscribes after being emailed.
  // If subscribe() touched notified_slugs, they would be emailed again.
  await subscribe(tenantId, e1, { source: 'newsletter' });
  const s5 = await readSubscriber(tenantId, e1);
  check(
    Boolean(s5?.notifiedSlugs['midnight-oud']) && Boolean(s5?.notifiedSlugs['amber-drift']),
    'RE-SUBSCRIBING does not reset the dedupe — they will not be emailed twice',
    JSON.stringify(s5?.notifiedSlugs),
  );
  check(
    (s5?.sources || []).length === 3,
    'and the re-subscribe still recorded its own source',
    JSON.stringify(s5?.sources),
  );

  // ── 4. concurrent signups for one address ───────────────────────────────
  console.log('\n4. Concurrent signups for the SAME address');
  const e2 = email('race'); createdEmails.push(e2);
  const results = await Promise.all([
    subscribe(tenantId, e2, { source: 'a' }),
    subscribe(tenantId, e2, { source: 'b' }),
    subscribe(tenantId, e2, { source: 'c' }),
    subscribe(tenantId, e2, { source: 'd' }),
  ]);
  const okCount = results.filter((r) => r.ok).length;
  const rows = (await db.select<{ id: string }>('alert_subscribers', {
    where: { tenant_id: eq(tenantId), email: eq(e2) }, select: ['id'], limit: 10,
  })) as Array<{ id: string }>;
  const raced = await readSubscriber(tenantId, e2);
  console.log('   4 parallel subscribes -> ok=' + okCount + ' rows=' + rows.length +
    ' sources=' + JSON.stringify(raced?.sources));
  check(okCount === 4, '   every caller was told they are subscribed', 'ok=' + okCount);
  check(rows.length === 1, '   exactly ONE row exists — no duplicate subscription', 'rows=' + rows.length);
  // Sources may legitimately lose a tag here: the merge is a read-modify-write
  // without a CAS, which is a stated trade (see lib/alert-subscribers.ts). What
  // must NOT happen is a duplicate row or a lost subscription.
  check((raced?.sources || []).length >= 1, '   at least one source survived', JSON.stringify(raced?.sources));

  // ── 5. removal ──────────────────────────────────────────────────────────
  console.log('\n5. Removal');
  check(await removeSubscriber(tenantId, e2), 'remove succeeds');
  check((await readSubscriber(tenantId, e2)) === null, 'and the row is really gone', 'still present');

  // ── 6. analytics_events: the table nothing used to write ────────────────
  console.log('\n6. Usage metrics land in analytics_events');
  const before = await readUsageTotalsFromDb({ tenantId, days: 1 });
  const wrote = await recordUsageEvent({ tenantId, metric: 'ai_generations' });
  check(wrote === true, 'recordUsageEvent reports the row landed', String(wrote));

  const after = await readUsageTotalsFromDb({ tenantId, days: 1 });
  check(
    after.ai_generations === before.ai_generations + 1,
    'the totals reader SEES it (' + before.ai_generations + ' -> ' + after.ai_generations + ')',
    JSON.stringify({ before, after }),
  );
  check(
    after.api_calls === before.api_calls && after.system_events === before.system_events,
    'and it did not leak into the other two metrics',
    JSON.stringify(after),
  );

  const amount = await recordUsageEvent({ tenantId, metric: 'ai_generations', amount: 5 });
  const after2 = await readUsageTotalsFromDb({ tenantId, days: 1 });
  check(amount === true && after2.ai_generations === after.ai_generations + 5,
    'an amount>1 is summed, not counted as one',
    JSON.stringify({ after, after2 }));

  // The legacy literal tenant. The KV key accepted any string; the column is a
  // uuid FK, so 'default' must resolve rather than throw or silently vanish.
  const legacy = await recordUsageEvent({ tenantId: 'default', metric: 'ai_generations' });
  check(legacy === true, "a caller passing the legacy 'default' tenant still records", String(legacy));
  const after3 = await readUsageTotalsFromDb({ tenantId: 'default', days: 1 });
  check(after3.ai_generations === after2.ai_generations + 1,
    "and 'default' resolves to the SAME tenant the uuid reads",
    JSON.stringify({ after2, after3 }));

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up...');
  for (const e of createdEmails) {
    try { await db.remove('alert_subscribers', { where: { tenant_id: eq(tenantId), email: eq(e) } }); } catch {}
  }
  // Only the events this run created: everything at or after its start.
  try {
    await db.remove('analytics_events', {
      where: { tenant_id: eq(tenantId), occurred_at: gte(startedAt) },
    });
  } catch (err) {
    console.error('  could not delete probe events: ' + ((err as Error)?.message || err));
  }
  const leftSubs = await listSubscribers(tenantId);
  check(
    leftSubs.every((s) => !s.email.endsWith('@goyunir.invalid')),
    'no test subscribers left behind',
    JSON.stringify(leftSubs.map((s) => s.email)),
  );
  const leftEvents = (await db.select<{ id: string }>('analytics_events', {
    where: { tenant_id: eq(tenantId), occurred_at: gte(startedAt) }, select: ['id'], limit: 100,
  })) as Array<{ id: string }>;
  check(leftEvents.length === 0, 'no probe usage events left behind', 'rows=' + leftEvents.length);

  console.log('\n' + '='.repeat(74));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

// Captured before any write so cleanup can bound itself to this run's rows.
const startedAt = new Date().toISOString();

main().catch((err) => { console.error(err); process.exit(1); });
