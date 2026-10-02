/**
 * SECRETS CHECK: is every secret in the manifest (secrets-manifest.ts) set,
 * in the place it belongs? Prints NAMES and present/missing only. Values are
 * never read into output: Worker secrets come from `wrangler secret list`
 * (names only), database secrets as "is this column non-empty" (the value is
 * tested inside this process and discarded), local ones as "is it set".
 *
 *   npx tsx scripts/bootstrap/check-secrets.ts [--worker <name>]
 * Exit 1 when a required secret is missing.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SECRETS, checkSecrets } from './secrets-manifest.ts';

const envPath = join(process.cwd(), '.env.local');
const localNames = new Set<string>();
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m) { if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); if (m[2].trim()) localNames.add(m[1]); } }
for (const [k, v] of Object.entries(process.env)) if (v && v.trim()) localNames.add(k);

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const worker = arg('--worker') || 'customattempt-1';

function workerSecretNames(): Set<string> {
  try {
    const out = execSync('npx wrangler secret list --name ' + worker, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 90_000 });
    return new Set([...out.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
  } catch {
    console.log('  (could not list the Worker\'s secrets: is wrangler logged in to the right account?)');
    return new Set();
  }
}

async function databaseSecretNames(): Promise<Set<string>> {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const cols = SECRETS.filter((s) => s.place === 'database').map((s) => s.column!);
  if (!url || !key) return new Set();
  const r = await fetch(url + '/rest/v1/global_platform_settings?select=' + cols.join(',') + '&limit=1', { headers: { apikey: key, authorization: 'Bearer ' + key } });
  const row: any = r.ok ? ((await r.json()) as any[])[0] || {} : {};
  return new Set(cols.filter((c) => String(row[c] ?? '').trim() !== ''));
}

(async () => {
  const { checks, missingRequired } = checkSecrets({ worker: workerSecretNames(), database: await databaseSecretNames(), local: localNames });
  for (const place of ['worker', 'database', 'local'] as const) {
    console.log('\n' + place);
    for (const c of checks.filter((x) => x.place === place)) console.log('  ' + (c.present ? 'set     ' : c.required ? 'MISSING ' : 'not set ') + c.name + (c.required ? '' : ' (optional)'));
  }
  console.log('\n' + (missingRequired.length ? 'MISSING REQUIRED: ' + missingRequired.join(', ') : 'ALL REQUIRED SECRETS SET'));
  process.exit(missingRequired.length ? 1 : 0);
})().catch((e) => { console.error(String((e as Error)?.message || e)); process.exit(1); });
