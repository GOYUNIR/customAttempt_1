/**
 * DRAW RUN VERIFICATION (DEFERRED-7, migration 00025).
 *
 *   npm run verify:draw-runs
 *
 * Apply 00025 first — the script says so in English rather than failing with a
 * PostgREST error.
 *
 * A draw run is the audit record of the moment this store takes money from a
 * set of customers. What has to be true:
 *
 *   - a run is recorded with its winners, its totals and HOW it was triggered
 *     (an automatic cron draw and an operator pressing the button are different
 *     events, and telling them apart is most of what an incident review needs)
 *   - reading it back returns what was written, in the right order
 *   - a FAILED read is distinguishable from "no draws have run". The first
 *     version of lib/draw-runs.ts caught its own errors and returned [], which
 *     would have rendered an empty draw history with no sign that the record
 *     could not be read — the exact silent-fallback pattern this codebase keeps
 *     finding. The reads now throw; this asserts that they do.
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
const MARKER = 'verify-' + STAMP + '@goyunir.invalid';

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { recordDrawRun, listDrawRuns, readLastDrawRun } = await import('../lib/draw-runs');

  const db = getDb();
  if (!db.configured) { console.error('No Supabase service credentials.'); process.exit(2); }
  const tenantId = await ensureDefaultTenant();

  try {
    await db.select('drop_draw_runs', { select: ['id'], limit: 1 });
  } catch (err) {
    console.error('\npublic.drop_draw_runs is not reachable — apply ' +
      'supabase/migrations/00025_drop_draw_runs.sql first.\n  (' + ((err as Error)?.message || err) + ')');
    process.exit(2);
  }

  console.log('\nDraw runs — the audit record of a draw');
  console.log('='.repeat(70));
  console.log('tenant: ' + tenantId + '\n');

  const createdIds: string[] = [];

  // ── 1. record ───────────────────────────────────────────────────────────
  console.log('1. Recording a run');
  const winners = [
    { email: MARKER, product: 'Verify Parfum', size: '50ml', status: 'SUCCESS_CHARGED', amountCents: 12500, orderRef: 'VR-' + STAMP },
    { email: 'declined-' + MARKER, product: 'Verify Parfum', size: '50ml', status: 'WINNER_DECLINED', amountCents: 0 },
  ];
  const runId = await recordDrawRun({
    tenantId,
    timezone: 'America/Los_Angeles',
    triggerSource: 'manual',
    winners,
    totalCharges: 1,
    totalRevenueCents: 12500,
  });
  check(Boolean(runId), 'a run is recorded', String(runId));
  if (runId) createdIds.push(runId);

  const last = await readLastDrawRun(tenantId);
  check(last?.id === runId, 'and is the most recent run', JSON.stringify(last?.id));
  check(last?.triggerSource === 'manual',
    'trigger_source records that an operator pressed the button', JSON.stringify(last?.triggerSource));
  check(last?.timezone === 'America/Los_Angeles',
    'the timezone is kept, so the run reads the same later as it did on the day',
    JSON.stringify(last?.timezone));
  check(last?.totalCharges === 1 && last?.totalRevenueCents === 12500,
    'totals survive the round trip', JSON.stringify({ c: last?.totalCharges, r: last?.totalRevenueCents }));
  check(last?.winners.length === 2, 'both winners are kept, charged and declined', JSON.stringify(last?.winners.length));
  check(last?.winners?.[0]?.orderRef === 'VR-' + STAMP,
    'and a charged winner points at its ORDER rather than restating the money',
    JSON.stringify(last?.winners?.[0]));

  // ── 2. ordering ─────────────────────────────────────────────────────────
  console.log('\n2. History order');
  const second = await recordDrawRun({
    tenantId, triggerSource: 'auto', winners: [], totalCharges: 0, totalRevenueCents: 0,
  });
  if (second) createdIds.push(second);
  const runs = await listDrawRuns(tenantId, 10);
  check(runs.length >= 2, 'both runs are listed', 'runs=' + runs.length);
  check(runs[0]?.id === second, 'newest first', JSON.stringify(runs[0]?.id));
  check(runs[0]?.triggerSource === 'auto',
    'and the cron run is distinguishable from the manual one', JSON.stringify(runs[0]?.triggerSource));

  // ── 3. a failed read must NOT look like "no draws" ──────────────────────
  console.log('\n3. A failed read is not reported as an empty history');
  let threw = false;
  try {
    // A tenant id that is a valid uuid but cannot exist forces a real query
    // against a bad filter rather than a fabricated error.
    await listDrawRuns('not-a-uuid-at-all');
  } catch {
    threw = true;
  }
  check(threw,
    'listDrawRuns THROWS on a read failure instead of returning []',
    'it returned normally — a failure would render as "no draws have ever run"');

  // ── cleanup ─────────────────────────────────────────────────────────────
  console.log('\nCleaning up...');
  for (const id of createdIds) {
    try { await db.remove('drop_draw_runs', { where: { tenant_id: eq(tenantId), id: eq(id) } }); } catch { /* ignore */ }
  }
  const left = (await db.select<{ id: string }>('drop_draw_runs', {
    where: { tenant_id: eq(tenantId) }, select: ['id'], limit: 50,
  })) as Array<{ id: string }>;
  check(left.every((r) => !createdIds.includes(r.id)), 'test runs removed', 'left=' + left.length);

  console.log('\n' + '='.repeat(70));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
