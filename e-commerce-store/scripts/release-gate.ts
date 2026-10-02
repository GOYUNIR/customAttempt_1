/**
 * RELEASE GATE — run before any deploy that touches money or identity.
 *
 *   npx tsx scripts/release-gate.ts            (everything, ~15 min)
 *   npx tsx scripts/release-gate.ts --quick    (skips the signup abuse simulation)
 *   npx tsx scripts/release-gate.ts --selftest (fake steps: exercises the retry rule)
 *
 * Runs, in order, against PRODUCTION (test-mode Stripe, sink-domain email:
 * nothing real is charged or emailed):
 *   typecheck, unit tests, readiness check (with production's config values),
 *   merchant isolation, a real test-mode purchase (+ refund), fulfilment,
 *   data export, product photos, webhook tolerance, portals at phone width,
 *   signup abuse (record mode); then it removes the data the proofs created
 *   (launch-reset --proof-only, backed up first).
 * Prints a go/no-go table; exit code 0 only when every step passed. Each
 * step's full output is kept in tenant-checkout-out/release-gate/<time>/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const quick = process.argv.includes('--quick');
const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(root, 'tenant-checkout-out', 'release-gate', stamp);
mkdirSync(outDir, { recursive: true });

/** Production's plain config values (wrangler.jsonc "vars"), so local checks judge what production runs. */
function productionVars(): Record<string, string> {
  const src = readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const block = /"vars"\s*:\s*\{([\s\S]*?)\}/.exec(src)?.[1] || '';
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/"([A-Z0-9_]+)"\s*:\s*"([^"]*)"/g)) vars[m[1]] = m[2];
  return vars;
}

type Step = { name: string; cmd: string; env?: Record<string, string>; pass: (code: number, out: string) => boolean };
const tsx = (file: string, args = '') => 'npx tsx scripts/' + file + (args ? ' ' + args : '');
const allPass = (code: number, out: string) => code === 0 && /ALL PASS/.test(out) && !/\bFAIL\b/.test(out);
const steps: Step[] = [
  { name: 'Typecheck', cmd: 'npx tsc --noEmit -p .', pass: (c) => c === 0 },
  { name: 'Unit tests', cmd: 'npm test', pass: (c, o) => c === 0 && /ℹ fail 0/.test(o) },
  { name: 'Readiness check (production config)', cmd: tsx('production-readiness-check.ts'), env: { ...productionVars(), NODE_ENV: 'production' }, pass: (c, o) => c === 0 && /0 error\(s\)/.test(o) },
  { name: 'Merchant isolation', cmd: tsx('verify-merchant-isolation.ts'), pass: allPass },
  { name: 'Purchase + refund (test mode)', cmd: tsx('verify-tenant-checkout.ts', '--refund'), pass: allPass },
  { name: 'Purchase (order to ship)', cmd: tsx('verify-tenant-checkout.ts'), pass: allPass },
  { name: 'Fulfilment', cmd: tsx('verify-merchant-fulfilment.ts'), pass: allPass },
  { name: 'Data export', cmd: tsx('verify-merchant-export.ts'), pass: allPass },
  { name: 'Product photos', cmd: tsx('verify-merchant-photos.ts'), pass: allPass },
  { name: 'Discount codes (flag on for the run)', cmd: tsx('verify-discounts.ts'), pass: allPass },
  { name: 'Webhooks tolerate deleted data', cmd: tsx('verify-webhook-tolerance.ts'), pass: allPass },
  { name: 'Prices and stock never stale at checkout', cmd: tsx('verify-no-stale-money.ts'), pass: allPass },
  { name: 'Portals at phone width', cmd: tsx('verify-portal-phone.ts'), pass: allPass },
  { name: 'Content policy blocks nothing real', cmd: tsx('csp-scan.ts'), pass: allPass },
  ...(quick ? [] : [{ name: 'Signup abuse (record mode)', cmd: tsx('verify-signup-abuse.ts'), pass: allPass }]),
  // Last: the proofs leave nothing behind (their orders, customers, signups,
  // accounts and recorded mail), backed up first like every reset.
  { name: 'Clean up proof data', cmd: tsx('launch-reset.ts', '--apply --proof-only'), pass: (c, o) => c === 0 && /ALL CHECKS PASS/.test(o) },
];

function runStep(s: Step): Promise<{ code: number; out: string; secs: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(s.cmd, { cwd: root, shell: true, env: { ...process.env, ...(s.env || {}) } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code: code ?? 1, out, secs: Math.round((Date.now() - t0) / 1000) }));
  });
}

/**
 * RETRY RULE (owner, 2026-10-02). A step is re-run once only when ALL hold:
 * - it failed with a CONNECTION timeout from this machine (the TCP connect
 *   never completed). Not a request timeout, because a slow server is a real
 *   finding. Not an HTTP error, a 1102 or an HTML page where JSON belonged:
 *   customers see those too.
 * - no check in it had failed (no FAIL line). An assertion about money,
 *   stock, isolation or auth is never retried.
 * Every retry is logged (retries.log, <step>.first-attempt.log) and counted
 * in the report. A step that needed a retry in the previous run too is a
 * real finding: NO-GO, not retried again.
 */
const CONNECT_TIMEOUT = /UND_ERR_CONNECT_TIMEOUT|Connect Timeout Error|\bETIMEDOUT\b/;
// --selftest: fake steps that exercise the retry rule itself (own history file).
const SELFTEST = process.argv.includes('--selftest');
const HISTORY = join(root, 'tenant-checkout-out', 'release-gate', SELFTEST ? 'selftest-retry-history.json' : 'retry-history.json');
if (SELFTEST) {
  const say = (text: string, code: number) => 'node -e "console.log(process.argv[1]); process.exit(' + code + ')" "' + text + '"';
  steps.splice(0, steps.length,
    { name: 'connect timeout, no failed check', cmd: say('code: UND_ERR_CONNECT_TIMEOUT', 1), pass: allPass },
    { name: 'connect timeout after a FAIL', cmd: say('FAIL money check / UND_ERR_CONNECT_TIMEOUT', 1), pass: allPass },
    { name: 'a 1102 page', cmd: say('error code: 1102', 1), pass: allPass },
    { name: 'a request timeout', cmd: say('timed out after 5000ms: The operation was aborted due to timeout', 1), pass: allPass },
    { name: 'a passing step', cmd: say('ALL PASS', 0), pass: allPass },
  );
}
const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const failLines = (out: string) => out.split(/\r?\n/).filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());

(async () => {
  let lastRetried: string[] = [];
  try { lastRetried = JSON.parse(readFileSync(HISTORY, 'utf8')).retried || []; } catch { /* first run */ }
  const retries: Array<{ step: string; reason: string; secondAttempt: string }> = [];
  const rows: Array<{ name: string; ok: boolean; secs: number; note: string }> = [];
  for (const s of steps) {
    process.stdout.write('… ' + s.name + '\n');
    let r = await runStep(s);
    let note = '';
    let forcedNoGo = false;
    if (!s.pass(r.code, r.out) && CONNECT_TIMEOUT.test(r.out) && failLines(r.out).length === 0) {
      const reason = (r.out.split(/\r?\n/).find((l) => CONNECT_TIMEOUT.test(l)) || '').trim().slice(0, 160);
      writeFileSync(join(outDir, slug(s.name) + '.first-attempt.log'), r.out);
      if (lastRetried.includes(s.name)) {
        forcedNoGo = true;
        note = '(connection timeout again: also retried last run, a real finding) ';
        retries.push({ step: s.name, reason, secondAttempt: 'not retried (two runs in a row)' });
      } else {
        r = await runStep(s);
        note = '(retried once: connection timeout) ';
        retries.push({ step: s.name, reason, secondAttempt: s.pass(r.code, r.out) ? 'passed' : 'failed' });
      }
    }
    writeFileSync(join(outDir, slug(s.name) + '.log'), r.out);
    const ok = !forcedNoGo && s.pass(r.code, r.out);
    const fails = failLines(r.out);
    const tail = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/npm notice/.test(l)).slice(-1)[0] || '';
    rows.push({ name: s.name, ok, secs: r.secs, note: note + (ok ? tail.slice(0, 60) : (fails[0] || tail).slice(0, 110)) });
  }
  writeFileSync(HISTORY, JSON.stringify({ at: stamp, retried: retries.map((x) => x.step) }, null, 2));
  writeFileSync(join(outDir, 'retries.log'), retries.map((x) => x.step + '\n  reason: ' + x.reason + '\n  second attempt: ' + x.secondAttempt).join('\n') + '\n');
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log('\nRELEASE GATE  ' + new Date().toISOString() + '\n');
  for (const r of rows) console.log((r.ok ? ' GO    ' : ' NO-GO ') + r.name.padEnd(w) + '  ' + String(r.secs).padStart(4) + 's  ' + r.note);
  console.log('\nRetries: ' + retries.length + (retries.length ? '' : ' (none)'));
  for (const x of retries) console.log('  ' + x.step + ': ' + x.reason + '  -> ' + x.secondAttempt);
  const go = rows.every((r) => r.ok);
  console.log('\n' + (go ? 'GO: every step passed.' : 'NO-GO: ' + rows.filter((r) => !r.ok).length + ' step(s) failed.') + '  Logs: ' + outDir);
  process.exit(go ? 0 : 1);
})();
