/**
 * WEBHOOK DEDUPE VERIFICATION (00031).
 *
 *   npm run verify:webhook-dedupe
 *
 * The KV claim this replaces was documented as atomic and was not — a lost
 * update in that path was observed in production. So the property checked
 * here is the one that failed: under real CONCURRENCY against the real
 * database, exactly one claimer wins. Sequential checks alone would have
 * passed the KV version too.
 *
 * Also checks: a finished key is never reclaimed; an abandoned claim is
 * reclaimed by exactly one racing retry; the backfill carried the KV history
 * over. Writes only rows under scope 'verify-*', removed at the end.
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

let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? '\n     ' + detail : ''));
}

const STAMP = Date.now().toString(36);
const SCOPE = 'verify-' + STAMP;

async function main() {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { claimWebhookKey, completeWebhookKey, STALE_CLAIM_MS } = await import('../lib/webhook-dedupe');
  const { createKvClient, safeParseKvItem } = await import('../lib/server-config');
  const db = getDb();

  console.log('\nWebhook dedupe — one winner, decided by the database');
  console.log('='.repeat(74));

  const rowOf = async (key: string) => ((await db.select<any>('webhook_dedupe', {
    where: { scope: eq(SCOPE), dedupe_key: eq(key) }, select: ['status', 'claimed_at', 'completed_at'], limit: 1,
  })) as any[])[0];

  console.log('1. Sequential');
  check(await claimWebhookKey(SCOPE, 'seq') === 'claimed', 'first claim wins');
  check(await claimWebhookKey(SCOPE, 'seq') === 'duplicate', 'second claim is a duplicate');
  check((await rowOf('seq'))?.status === 'claimed', 'row is claimed until completed');

  console.log('\n2. Concurrent — the property the KV claim could not guarantee');
  const N = 12;
  const outcomes = await Promise.all(Array.from({ length: N }, () => claimWebhookKey(SCOPE, 'race')));
  const winners = outcomes.filter((o) => o === 'claimed').length;
  check(winners === 1, N + ' simultaneous claims -> exactly one winner', 'winners=' + winners + ' ' + JSON.stringify(outcomes));
  check(outcomes.filter((o) => o === 'duplicate').length === N - 1, 'every other claimer is told duplicate');

  console.log('\n3. Completion is final');
  await completeWebhookKey(SCOPE, 'seq');
  const done = await rowOf('seq');
  check(done?.status === 'done' && Boolean(done?.completed_at), 'complete() marks it done with a timestamp', JSON.stringify(done));
  const farFuture = Date.now() + STALE_CLAIM_MS * 10;
  check(await claimWebhookKey(SCOPE, 'seq', farFuture) === 'duplicate', 'a done key is never reclaimed, however old');

  console.log('\n4. Abandoned claims are recovered, by exactly one retry');
  // A claim made "long ago" that nobody completed: a crashed handler.
  check(await claimWebhookKey(SCOPE, 'crashed', Date.now() - STALE_CLAIM_MS - 60_000) === 'claimed', 'a claim is taken, then abandoned');
  check(await claimWebhookKey(SCOPE, 'fresh') === 'claimed' && await claimWebhookKey(SCOPE, 'fresh') === 'duplicate',
    'a FRESH claim is not reclaimable (the original run may still be working)');
  const retries = await Promise.all(Array.from({ length: 6 }, () => claimWebhookKey(SCOPE, 'crashed')));
  const reclaimed = retries.filter((o) => o === 'reclaimed').length;
  check(reclaimed === 1, '6 racing retries -> exactly one reclaims the abandoned claim', JSON.stringify(retries));

  console.log('\n5. The KV history came across');
  const redis = createKvClient();
  const raw = redis ? await redis.get('entries:processed') : null;
  const parsed = safeParseKvItem<any>(raw);
  let kvMembers: string[] = [];
  if (Array.isArray(parsed)) kvMembers = parsed.map((e: any) => (typeof e === 'string' ? e : e?.m)).filter(Boolean);
  // Fall back to reading the members the storage client exposes.
  if (kvMembers.length === 0 && redis) {
    try { kvMembers = (await redis.zrange('entries:processed', 0, -1)) as string[]; } catch {}
  }
  let missing = 0;
  for (const m of kvMembers) {
    const r = ((await db.select<any>('webhook_dedupe', {
      where: { scope: eq('stripe_checkout_session'), dedupe_key: eq(m) }, select: ['status'], limit: 1,
    })) as any[])[0];
    if (!r) missing++;
  }
  check(kvMembers.length > 0, 'the KV set was readable (' + kvMembers.length + ' sessions)');
  check(missing === 0, 'every session KV knew about is in the table', missing + ' of ' + kvMembers.length + ' missing');

  await db.remove('webhook_dedupe', { where: { scope: eq(SCOPE) } });
  const left = await db.select('webhook_dedupe', { where: { scope: eq(SCOPE) }, select: ['dedupe_key'], limit: 5 });
  check(left.length === 0, 'test rows removed');

  console.log('\n' + '='.repeat(74));
  console.log(fail === 0 ? 'ALL CHECKS PASSED' : fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
