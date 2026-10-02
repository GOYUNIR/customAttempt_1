/**
 * RELEASE GATE — run before any deploy that touches money or identity.
 *
 *   npx tsx scripts/release-gate.ts            (everything, ~15 min)
 *   npx tsx scripts/release-gate.ts --quick    (skips the signup abuse simulation)
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

(async () => {
  const rows: Array<{ name: string; ok: boolean; secs: number; note: string }> = [];
  for (const s of steps) {
    process.stdout.write('… ' + s.name + '\n');
    let r = await runStep(s);
    // One retry, and only for a network-level failure on THIS machine (DNS,
    // reset, connect timeout): not a product failure. Shown in the table.
    let retried = false;
    if (!s.pass(r.code, r.out) && /fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN/.test(r.out)) {
      writeFileSync(join(outDir, s.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.network-error.log'), r.out);
      retried = true;
      r = await runStep(s);
    }
    const file = join(outDir, s.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.log');
    writeFileSync(file, r.out);
    const ok = s.pass(r.code, r.out);
    const fails = r.out.split(/\r?\n/).filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
    const tail = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !/npm notice/.test(l)).slice(-1)[0] || '';
    rows.push({ name: s.name, ok, secs: r.secs, note: (retried ? '(retried after a network error) ' : '') + (ok ? tail.slice(0, 60) : (fails[0] || tail).slice(0, 110)) });
  }
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log('\nRELEASE GATE  ' + new Date().toISOString() + '\n');
  for (const r of rows) console.log((r.ok ? ' GO    ' : ' NO-GO ') + r.name.padEnd(w) + '  ' + String(r.secs).padStart(4) + 's  ' + r.note);
  const go = rows.every((r) => r.ok);
  console.log('\n' + (go ? 'GO: every step passed.' : 'NO-GO: ' + rows.filter((r) => !r.ok).length + ' step(s) failed.') + '  Logs: ' + outDir);
  process.exit(go ? 0 : 1);
})();
