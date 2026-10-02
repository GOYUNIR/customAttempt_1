/**
 * BOOTSTRAP-IN-A-BOX: a fresh install of the platform under any name and
 * domain (BOOTSTRAP-RUNBOOK.md). DRY RUN by default: prints, per step, what
 * already exists and what it would do. --apply does it.
 *
 *   npx tsx scripts/bootstrap/run.ts --config bootstrap.json [--env bootstrap.env] [--apply] [--only <step>]
 *   npx tsx scripts/bootstrap/run.ts --name "Larkspur Commerce" --domain larkspur.example \
 *       --target local --fake-services --apply          (the local rehearsal)
 *
 * Inputs: inputs.ts (name, domain, account ids, addresses). Secrets: read by
 * NAME from --env <file> or the shell only. This script never reads the old
 * stack's .env.local, so the old project's keys cannot leak into a new
 * install. Nothing secret is ever printed.
 *
 * --target remote (default)   SQL through the Supabase Management API
 *                             (SUPABASE_ACCESS_TOKEN + input supabaseProject)
 * --target local              SQL on an in-memory PGlite (rehearsal)
 * --fake-services             Cloudflare/Resend/Stripe/site answered by fakes.ts
 * Always writes the Worker config to bootstrap-out/<domain>/wrangler.jsonc.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readInputs, resolveInputs } from './inputs.ts';
import { wranglerConfigText } from './wrangler-config.ts';
import { STEPS, SETTINGS_ROW_ID, type Ctx, type Http } from './steps.ts';
import { migrationFiles, SUPABASE_PRELUDE } from './pglite-install.ts';
import { fakeWorld, fakeHttp } from './fakes.ts';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const APPLY = has('--apply');
const LOCAL = flag('--target') === 'local';
const FAKE = has('--fake-services');
const ONLY = flag('--only');

// Secrets: an explicit env file and the shell. NOT .env.local.
const fileEnv: Record<string, string> = {};
if (flag('--env')) {
  if (!existsSync(flag('--env'))) throw new Error('--env file not found');
  for (const line of readFileSync(flag('--env'), 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m) fileEnv[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
}
const env = (n: string) => String(fileEnv[n] ?? process.env[n] ?? '');

const realHttp: Http = async (url, init = {}) => {
  const r = await fetch(url, { method: init.method || 'GET', headers: init.headers, body: init.body, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
};

(async () => {
  const inputs = resolveInputs(readInputs(argv));
  console.log('BOOTSTRAP ' + (APPLY ? 'APPLY' : 'DRY RUN') + '  "' + inputs.name + '" on ' + inputs.domain + (LOCAL ? '  [local database]' : '') + (FAKE ? '  [fake services]' : ''));

  // The Worker config: always generated, never written over the repo's own.
  const outDir = join(process.cwd(), 'bootstrap-out', inputs.domain);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'wrangler.jsonc'), wranglerConfigText(inputs));
  console.log('\nWorker config: ' + join('bootstrap-out', inputs.domain, 'wrangler.jsonc'));

  // The database.
  let sql: (q: string) => Promise<any[]>;
  if (LOCAL) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
    const db: any = new PGlite({ extensions: { pgcrypto } });
    await db.exec(SUPABASE_PRELUDE);
    sql = async (q) => {
      if (/^\s*notify\b/i.test(q)) return [];
      const res = await db.exec(q);
      return res[res.length - 1]?.rows || [];
    };
  } else {
    const token = env('SUPABASE_ACCESS_TOKEN');
    sql = async (q) => {
      if (!token || !inputs.supabaseProject) throw new Error('remote database needs SUPABASE_ACCESS_TOKEN and the input supabaseProject');
      const r = await fetch('https://api.supabase.com/v1/projects/' + inputs.supabaseProject + '/database/query', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
      const j: any = await r.json().catch(() => null);
      if (!r.ok) throw new Error('database: ' + String(j?.message || r.status).slice(0, 200));
      return Array.isArray(j) ? j : [];
    };
  }

  const world = fakeWorld(inputs.domain);
  const stored: string[] = [];
  const ctx: Ctx = {
    inputs,
    http: FAKE ? fakeHttp(world) : realHttp,
    env: (n) => (FAKE && !env(n) ? 'fake-' + n.toLowerCase() + '-0123456789' : env(n)),
    migrations: migrationFiles().map((f) => [f.split(/[\\/]/).pop()!, readFileSync(f, 'utf8')] as [string, string]),
    sql,
    random: () => randomBytes(32).toString('hex'),
    async workerSecretNames() {
      if (FAKE || LOCAL) return new Set(stored.filter((s) => s.startsWith('worker:')).map((s) => s.slice(7)));
      const r = spawnSync('npx', ['wrangler', 'secret', 'list', '--name', inputs.worker], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.status !== 0) return new Set();
      return new Set([...String(r.stdout).matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
    },
    async putSecret(place, name, value) {
      stored.push(place + ':' + name);
      if (FAKE || LOCAL) return;
      if (place === 'worker') {
        const r = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--name', inputs.worker], { input: value, encoding: 'utf8', shell: true, stdio: ['pipe', 'ignore', 'pipe'] });
        if (r.status !== 0) throw new Error('could not set the Worker secret ' + name + ' (wrangler exit ' + r.status + ')');
      } else {
        const url = env('SUPABASE_URL').replace(/\/+$/, ''), key = env('SUPABASE_SERVICE_ROLE_KEY');
        const r = await fetch(url + '/rest/v1/global_platform_settings?id=eq.' + SETTINGS_ROW_ID, { method: 'PATCH', headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ [name]: value }) });
        if (!r.ok) throw new Error('could not store ' + name + ' in the settings row (' + r.status + ')');
      }
    },
  };

  let failed = false;
  /** One pass over the steps; returns how many actions were still needed. */
  const pass = async (apply: boolean): Promise<number> => {
    let needed = 0;
    for (const step of STEPS) {
      if (ONLY && step.id !== ONLY) continue;
      let plan;
      try { plan = await step.plan(ctx); } catch (e) { console.log('\n[' + step.id + '] ' + step.title + '\n  ERROR planning: ' + String((e as Error).message).slice(0, 200)); failed = true; continue; }
      console.log('\n[' + step.id + '] ' + step.title);
      if (plan.blocked) { console.log('  BLOCKED: ' + plan.blocked); continue; }
      if (plan.done.length) console.log('  already there: ' + (plan.done.length > 6 ? plan.done.length + ' items (' + plan.done.slice(0, 3).join('; ') + '; …)' : plan.done.join('; ')));
      if (!plan.todo.length) { console.log('  nothing to do'); continue; }
      needed += plan.todo.length;
      const migrations = plan.todo.filter((a) => a.describe.startsWith('apply migration '));
      for (const a of plan.todo) {
        const quiet = migrations.length > 4 && migrations.indexOf(a) >= 2 && a !== migrations[migrations.length - 1];
        if (!apply) { if (!quiet) console.log('  would: ' + a.describe); else if (a === migrations[2]) console.log('  would: … ' + (migrations.length - 3) + ' more migrations …'); continue; }
        try { const note = await a.run(); if (!quiet) console.log('  did: ' + a.describe + ' -> ' + note); else if (a === migrations[2]) console.log('  did: … ' + (migrations.length - 3) + ' more migrations …'); }
        catch (e) { console.log('  FAILED: ' + a.describe + ': ' + String((e as Error).message).slice(0, 200)); failed = true; return needed; }
      }
    }
    return needed;
  };
  await pass(APPLY);
  // --twice (rehearsal): plan again after applying; a correct bootstrap has
  // nothing left to do.
  if (APPLY && has('--twice') && !failed) {
    console.log('\n──── second pass (must find nothing to do) ────');
    const again = await pass(false);
    console.log('\nSecond pass: ' + (again === 0 ? 'nothing to do (idempotent)' : again + ' action(s) still planned: NOT idempotent'));
    if (again !== 0) failed = true;
  }
  if (stored.length) console.log('\nSecrets stored (names only): ' + stored.join(', '));
  if (FAKE && APPLY) console.log('Fake services afterwards: ' + world.dns.length + ' DNS records, ' + world.buckets.length + ' bucket(s), ' + world.widgets.length + ' widget(s), ' + world.resendDomains.length + ' sending domain(s), ' + world.webhooks.length + ' webhook(s), setup calls ' + world.setupCalls.length);
  console.log('\n' + (failed ? 'BOOTSTRAP STOPPED ON AN ERROR' : APPLY ? 'BOOTSTRAP APPLIED' : 'DRY RUN DONE (nothing changed)'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(String((e as Error)?.message || e)); process.exit(1); });
