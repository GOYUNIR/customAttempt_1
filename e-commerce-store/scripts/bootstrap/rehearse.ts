/**
 * NAME REHEARSAL: run the real Worker bundle locally (wrangler dev) as a
 * made-up platform, then check every platform-facing surface for the current
 * stand-in identity. Proves the name, domain and addresses come from config.
 *
 *   npx opennextjs-cloudflare build        (once, after code changes)
 *   npx tsx scripts/bootstrap/rehearse.ts [--name "Larkspur Commerce"] [--domain larkspur.example] \
 *       [--old "GOYUNIR,goyunir.com"]
 *
 * The local Worker gets ONLY the database connection (read from .env.local,
 * never printed) and EMAIL_DRIVER=record, so it cannot send real mail; signup
 * stays off. Temporary files (wrangler.rehearsal.jsonc, .dev.vars) are removed
 * afterwards. Exit 1 when an old value shows up.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveInputs } from './inputs.ts';
import { wranglerConfigText } from './wrangler-config.ts';

const argv = process.argv.slice(2);
const flag = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const NAME = flag('--name', 'Larkspur Commerce');
const DOMAIN = flag('--domain', 'larkspur.example');
const OLD = flag('--old', 'GOYUNIR,goyunir.com');
const PORT = 8799;
const root = process.cwd();
const cfgPath = join(root, 'wrangler.rehearsal.jsonc');
const devVars = join(root, '.dev.vars');
if (existsSync(devVars)) { console.error('.dev.vars already exists: not overwriting it'); process.exit(2); }
if (!existsSync(join(root, '.open-next', 'worker.js'))) { console.error('no build: run npx opennextjs-cloudflare build first'); process.exit(2); }

const local: Record<string, string> = {};
for (const line of readFileSync(join(root, '.env.local'), 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m) local[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }

const inputs = resolveInputs({ name: NAME, domain: DOMAIN, cloudflareAccountId: 'rehearsal', worker: 'rehearsal' });
writeFileSync(cfgPath, wranglerConfigText(inputs));
writeFileSync(devVars, [
  'SUPABASE_URL=' + local.SUPABASE_URL,
  'SUPABASE_ANON_KEY=' + (local.SUPABASE_ANON_KEY || local.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''),
  'SUPABASE_SERVICE_ROLE_KEY=' + local.SUPABASE_SERVICE_ROLE_KEY,
  'EMAIL_DRIVER=record',
  // wrangler dev answers every request as the first route's host; the check
  // names the host it means in x-forwarded-host, trusted HERE only.
  'TRUST_FORWARDED_HOST=true',
  'RESEND_FROM=' + inputs.sendingFrom,
].join('\n') + '\n');

const cleanup = () => { for (const f of [cfgPath, devVars]) { try { rmSync(f); } catch { /* gone */ } } };
console.log('REHEARSAL  "' + NAME + '" on ' + DOMAIN + '  (local Worker on :' + PORT + ', old values: ' + OLD + ')');
const dev = spawn('npx', ['wrangler', 'dev', '--config', 'wrangler.rehearsal.jsonc', '--port', String(PORT), '--ip', '127.0.0.1', '--local'], { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
dev.stdout.on('data', (d) => { log += d; });
dev.stderr.on('data', (d) => { log += d; });
const stop = () => {
  if (process.platform !== 'win32') { dev.kill('SIGTERM'); return; }
  // npx -> wrangler -> workerd: stop whatever listens on the port, and its tree.
  const ns = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const pid = String(ns.stdout || '').split(/\r?\n/).find((l) => l.includes(':' + PORT + ' ') && l.includes('LISTENING'))?.trim().split(/\s+/).pop();
  for (const p of [pid, String(dev.pid)].filter(Boolean)) spawnSync('taskkill', ['/PID', String(p), '/T', '/F']);
};

(async () => {
  // A Worker left on the port by an interrupted run would answer instead of
  // this one (or hang): refuse rather than check the wrong server.
  const busy = await fetch('http://127.0.0.1:' + PORT + '/api/health', { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (busy) { console.log('port ' + PORT + ' is already in use (a Worker left by an interrupted run?): stop it first'); dev.kill(); cleanup(); process.exit(2); }
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/health', { headers: { host: DOMAIN } }); up = r.status > 0; } catch { /* not yet */ }
  }
  if (!up) { console.log('the local Worker did not start:\n' + log.slice(-1500)); stop(); cleanup(); process.exit(1); }
  console.log('local Worker up\n');
  const check = spawnSync('npx', ['tsx', 'scripts/bootstrap/identity-check.ts', '--old', '"' + OLD + '"', '--base', 'http://127.0.0.1:' + PORT, '--host', DOMAIN, '--config', 'wrangler.rehearsal.jsonc'], {
    cwd: root, shell: true, encoding: 'utf8',
    env: { ...process.env, PLATFORM_NAME: NAME, PLATFORM_ROOT_DOMAIN: DOMAIN, SUPPORT_EMAIL: inputs.supportEmail, OPERATOR_ALERT_EMAIL: inputs.alertEmail, RESEND_FROM: inputs.sendingFrom, EMAIL_FROM: '', REPLY_TO_EMAIL: '' },
  });
  console.log(String(check.stdout || '').split(/\r?\n/).filter((l) => !/npm notice/.test(l)).join('\n'));
  if (check.stderr && check.status !== 0) console.log(String(check.stderr).slice(-800));
  stop();
  cleanup();
  process.exit(check.status === 0 ? 0 : 1);
})().catch((e) => { console.error(e); stop(); cleanup(); process.exit(1); });
