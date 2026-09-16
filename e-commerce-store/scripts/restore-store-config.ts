/**
 * RESTORE MERCHANT STORE CONFIG (SEV-2 fix, H2 step 1).
 *
 *   npx tsx scripts/restore-store-config.ts --after <url>            # DRY RUN
 *   npx tsx scripts/restore-store-config.ts --after <url> --commit   # apply
 *
 * The Phase G flip routed /api/store through tenant_store_config, which has
 * never had a row, so the live storefront has been serving BUILT-IN DEFAULTS
 * and ignoring everything the merchant configured (ARCHITECTURE.md SEV-2).
 *
 * This copies store:config into tenant_store_config verbatim. No transform,
 * no field mapping -- the Postgres path feeds that value to the same
 * mergePublicConfig() the KV path already feeds it to.
 *
 * THE "AFTER" IS NOT SIMULATED. --after points at a server running the KV
 * branch (a local `next dev` without USE_POSTGRES_PRIMARY), whose /api/store
 * config IS mergePublicConfig(store:config) -- the real function, real code
 * path. Re-deriving the merge here would just be a second implementation to
 * drift from the first, which is how this class of bug started.
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

const COMMIT = process.argv.includes('--commit');

/**
 * Config keys deliberately NOT copied.
 *
 * `legal`: the merchant saved EMPTY strings for companyName / terms /
 * privacy / shipping. mergePublicConfig spreads defaults then stored, so an
 * empty string WINS -- copying it verbatim would blank the live Terms,
 * Privacy and Shipping pages. Obviously-placeholder default copy is a less
 * bad live state than a blank legal page, so the defaults stay until real
 * legal text is written. Owner's call, recorded here rather than in a commit
 * message so the next reader sees why a key is missing from the row.
 *
 * This is a symptom of the wider issue tracked as ISSUE-1 in ARCHITECTURE.md:
 * the merge cannot distinguish "saved as empty" from "never set".
 */
const SKIP_KEYS = new Set(['legal']);
const afterIdx = process.argv.indexOf('--after');
const AFTER_BASE = afterIdx > -1 ? process.argv[afterIdx + 1] : '';
const LIVE_BASE = 'https://goyunir.com';

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

function decode(v: unknown): unknown {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return x; } }
  const inner = (x as { v?: unknown })?.v ?? x;
  if (typeof inner === 'string') { try { return JSON.parse(inner); } catch { return inner; } }
  return inner;
}

function preview(v: unknown, n = 72): string {
  const s = JSON.stringify(v ?? null);
  return s.length <= n ? s : s.slice(0, n) + `… (${s.length}B)`;
}

async function main() {
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.'); process.exit(2); }
  if (!AFTER_BASE) {
    console.error('Pass --after <url> pointing at a server running the KV branch\n' +
      '(a local `next dev` with USE_POSTGRES_PRIMARY unset). Without it there is\n' +
      'no honest "after" to show, only a re-derived guess.');
    process.exit(2);
  }

  console.log(`\nRestore merchant store config — ${COMMIT ? 'COMMIT' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(78));

  const kvRows = await (await fetch(`${url}/rest/v1/store_kv?key=eq.store%3Aconfig&select=value`, { headers: H })).json();
  const stored = decode(kvRows?.[0]?.value) as Record<string, unknown> | undefined;
  if (!stored || typeof stored !== 'object') { console.error('store:config is missing or unreadable — refusing to proceed.'); process.exit(2); }

  const tenants = await (await fetch(`${url}/rest/v1/tenants?select=id&limit=1`, { headers: H })).json();
  const tenantId = (tenants as Array<{ id: string }>)?.[0]?.id;
  if (!tenantId) { console.error('No tenant row found.'); process.exit(2); }

  const existing = await (await fetch(`${url}/rest/v1/tenant_store_config?tenant_id=eq.${tenantId}&select=tenant_id`, { headers: H })).json();
  console.log(`tenant: ${tenantId}`);
  console.log(`tenant_store_config rows for it today: ${(existing as unknown[])?.length ?? 0}`);
  console.log(`store:config size: ${JSON.stringify(stored).length}B, ${Object.keys(stored).length} keys\n`);

  const liveCfg = ((await (await fetch(`${LIVE_BASE}/api/store`, { headers: { 'Accept-Encoding': 'identity' } })).json())?.config || {}) as Record<string, unknown>;
  const afterCfg = ((await (await fetch(`${AFTER_BASE.replace(/\/+$/, '')}/api/store`)).json())?.config || {}) as Record<string, unknown>;

  for (const k of SKIP_KEYS) {
    console.log(`SKIPPING key "${k}" — not copied (see SKIP_KEYS); the live default stays.`);
  }
  const keys = [...new Set([...Object.keys(liveCfg), ...Object.keys(afterCfg)])]
    .filter((k) => !SKIP_KEYS.has(k))
    .sort();
  const changed: string[] = [];
  console.log('FIELD-BY-FIELD — what the live storefront serves now vs after this write');
  console.log('-'.repeat(78));
  for (const k of keys) {
    const a = JSON.stringify(liveCfg[k] ?? null);
    const b = JSON.stringify(afterCfg[k] ?? null);
    if (a === b) continue;
    changed.push(k);
    console.log(`\n  ${k}`);
    console.log(`    now:   ${preview(liveCfg[k])}`);
    console.log(`    after: ${preview(afterCfg[k])}`);
  }
  const unchanged = keys.length - changed.length;
  console.log('\n' + '-'.repeat(78));
  console.log(`${changed.length} key(s) CHANGE, ${unchanged} unchanged (already matching defaults).`);
  console.log(`payload: ${JSON.stringify(liveCfg).length}B -> ${JSON.stringify(afterCfg).length}B`);

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit to apply.\n');
    return;
  }

  const toWrite: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (!SKIP_KEYS.has(k)) toWrite[k] = v;
  const body = JSON.stringify([{ tenant_id: tenantId, config: toWrite, schedule_override: {}, social_override: {} }]);
  const res = await fetch(`${url}/rest/v1/tenant_store_config?on_conflict=tenant_id`, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=representation' },
    body,
  });
  if (!res.ok) { console.error(`\nWRITE FAILED (${res.status}): ${(await res.text()).slice(0, 400)}`); process.exit(1); }
  const written = await res.json();
  const size = JSON.stringify((written as Array<{ config?: unknown }>)?.[0]?.config ?? {}).length;
  console.log(`\nWROTE tenant_store_config for ${tenantId} — config ${size}B`);
  console.log('Verify against the LIVE storefront now; a row existing is not the same as it rendering.\n');
}

main().catch((e) => { console.error('failed:', e); process.exit(1); });
