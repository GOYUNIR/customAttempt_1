/**
 * NOTIFICATION RECOVERY VERIFICATION (ARCHITECTURE.md SEV-3).
 *
 *   npm run verify:notifications
 *
 * Proves the fix against a REAL delivery failure, not a stub: it calls the
 * actual sendWinnerEmail with an address Resend rejects (422 on example.com in
 * test mode) — the exact failure reproduced during the Phase D4.2 dry run,
 * where a winner was charged and the email vanished into a console line.
 *
 * Storage is in-memory so nothing touches a real queue. Everything else is
 * production code: the real email driver, the real queue logic, the real
 * health check.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadDotEnvLocal(): void {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

import {
  NOTIFICATION_MAX_ATTEMPTS,
  buildNotificationJob,
  enqueueNotification,
  flushNotifications,
  parseNotificationJob,
  type NotificationStorage,
} from '../lib/notification-queue';
import { checkNotificationDeadLetter } from '../lib/system-diagnostics-pure';

const QUEUE = 'notify:queue';
const DEAD = 'notify:dead';
let fail = 0;
function check(ok: boolean, name: string, detail = '') {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${detail}` : ''}`);
}

function memStore() {
  const lists: Record<string, string[]> = {};
  const s: NotificationStorage & { lists: Record<string, string[]> } = {
    lists,
    async rpush(k, ...v) { lists[k] = lists[k] || []; lists[k].push(...v); return lists[k].length; },
    async lrange(k, a, b) { return (lists[k] || []).slice(a, b + 1); },
    async lrem(k, _c, v) { const arr = lists[k] || []; const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); return i >= 0 ? 1 : 0; },
  };
  return s;
}

async function main() {
  console.log('\nNotification recovery — real delivery failure\n' + '='.repeat(56));

  const { sendWinnerEmail } = await import('../lib/email');
  const opts = {
    to: 'charged-but-untold@example.com', // Resend rejects example.com in test mode
    product: 'Dry Run Item',
    size: 'M',
    amountLabel: '$12.34',
  };

  // 1. The real failure, exactly as it happens in the charge path.
  const first = await sendWinnerEmail(opts);
  check(first?.ok === false, 'real sendWinnerEmail FAILS (the reproduced bug)', JSON.stringify(first?.error).slice(0, 110));

  // 2. Old behaviour: that result was discarded. New behaviour: it is queued.
  const store = memStore();
  await enqueueNotification(store, QUEUE, buildNotificationJob('winner_email', opts as never, 'Resend 422'));
  check((store.lists[QUEUE] || []).length === 1, 'failure is QUEUED instead of discarded');

  // 3. Retries happen out of band, using the real sender (which keeps failing).
  let flushes = 0;
  for (let i = 0; i < NOTIFICATION_MAX_ATTEMPTS + 1; i++) {
    await flushNotifications({
      storage: store, queueKey: QUEUE, deadLetterKey: DEAD,
      nowMs: Date.now() + 86_400_000 * (i + 1),
      send: async (job) => Boolean((await sendWinnerEmail(job.payload as never))?.ok),
    });
    flushes++;
  }
  check((store.lists[QUEUE] || []).length === 0, 'queue drains after exhausting attempts', `${flushes} flushes`);
  check((store.lists[DEAD] || []).length === 1, 'the charged-but-untold customer is DEAD-LETTERED, not lost');
  const dead = parseNotificationJob((store.lists[DEAD] || [])[0] || '');
  check(dead?.payload?.to === opts.to, 'dead-letter record identifies WHO to contact', String(dead?.payload?.to));
  check(dead?.attempts === NOTIFICATION_MAX_ATTEMPTS, 'records how many attempts were made', String(dead?.attempts));

  // 4. The health check turns it into something an operator will see.
  const health = checkNotificationDeadLetter((store.lists[DEAD] || []).length);
  check(health.status === 'error', 'health check reports ERROR (not a warning)', health.detail.slice(0, 90));

  // 5. Control: a recoverable failure is delivered on retry, never dead-lettered.
  const store2 = memStore();
  await enqueueNotification(store2, QUEUE, buildNotificationJob('winner_email', opts as never, 'transient'));
  let attempt = 0;
  await flushNotifications({
    storage: store2, queueKey: QUEUE, deadLetterKey: DEAD,
    nowMs: Date.now() + 86_400_000,
    send: async () => { attempt++; return true; }, // provider recovers
  });
  check((store2.lists[QUEUE] || []).length === 0 && (store2.lists[DEAD] || []).length === 0,
    'CONTROL: a recovered send is delivered and NOT dead-lettered', `${attempt} attempt(s)`);

  console.log('='.repeat(56));
  console.log(fail === 0 ? 'NOTIFICATION RECOVERY VERIFIED\n' : `${fail} FAILURE(S)\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness crashed:', e); process.exit(1); });
