/**
 * TENANT TRANSFER: move one store's CATALOG and CONFIGURATION from one
 * install to another (BOOTSTRAP-RUNBOOK.md: the original shop becomes an
 * ordinary tenant on the new platform; the proof fixture stores are recreated
 * with their ids so the proofs run unchanged).
 *
 *   npx tsx scripts/bootstrap/tenant-transfer.ts export --tenant <id> [--out file.json]
 *       reads the SOURCE (this repo's .env.local: the current install)
 *   npx tsx scripts/bootstrap/tenant-transfer.ts import --file file.json --env new.env \
 *       [--as-id <uuid>] [--as-slug <slug>] [--as-name "Name"] [--apply]
 *       writes the TARGET named by --env only (never .env.local); dry run unless --apply
 *
 * Moves: the tenant row, store config, themes, modules, shared stock pools,
 * products, variants, and stock counts (each set through stock_set, so the
 * count arrives with a "transfer" entry in the stock history).
 * Does NOT move: orders, customers, holds, entries, audit history (a fresh
 * install starts clean: owner decision 2026-10-02), the Stripe connected
 * account (it belongs to the OLD Stripe platform: the store reconnects),
 * custom domains (re-added and re-verified), subscriptions, staff accounts
 * (re-invited). Product photos: listed in the bundle's `media`; copy them with
 *   tenant-transfer.ts copy-media --file <bundle> --env new.env [--apply]
 * (same keys in the new bucket: no stored reference changes).
 * Idempotent: re-importing skips rows that already exist.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** In dependency order (parents first). */
export const TRANSFER_TABLES = ['tenants', 'tenant_store_config', 'tenant_themes', 'tenant_modules', 'shared_inventory_pools', 'products', 'product_variants'] as const;
export type Bundle = {
  version: 1;
  exportedAt: string;
  tenantId: string;
  tables: Record<string, any[]>;
  /** variant id -> units on hand at export. */
  stock: Record<string, number>;
  /** Photo keys and URLs the catalog and config point at. */
  media: string[];
};
export type TransferOptions = { asId?: string; asSlug?: string; asName?: string };

/** Everything a row references as media (keys like tenants/<id>/… and full URLs). */
export function mediaRefs(bundle: Pick<Bundle, 'tables'>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^tenants\/[0-9a-f-]{36}\//.test(v) || /^products\//.test(v) || /\/media\/r2\//.test(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const t of ['tenant_store_config', 'products', 'product_variants', 'tenant_themes']) walk(bundle.tables[t] || []);
  return [...out].sort();
}

/**
 * The rows to insert on the target (pure; tested): the tenant id and slug
 * remapped when asked, and what belongs to the OLD platform reset (the
 * Stripe connected account, custom domain state, plan grace).
 */
export function prepareRows(bundle: Bundle, opts: TransferOptions = {}): Record<string, any[]> {
  const from = bundle.tenantId;
  const to = opts.asId || from;
  const out: Record<string, any[]> = {};
  for (const t of TRANSFER_TABLES) {
    out[t] = (bundle.tables[t] || []).map((row) => {
      const r = { ...row };
      if ('tenant_id' in r && r.tenant_id === from) r.tenant_id = to;
      return r;
    });
  }
  // What belongs to the OLD platform is dropped, so the new database's own
  // defaults apply (not guessed values): the connected account, the custom
  // domain and its verification state, plan grace.
  const OLD_PLATFORM_FIELDS = ['stripe_account_id', 'connect_charges_enabled', 'connect_payouts_enabled', 'connect_requirements', 'connect_synced_at',
    'custom_domain', 'cloudflare_hostname_id', 'domain_status', 'ssl_status', 'domain_verification', 'domain_checked_at', 'plan_grace_until'];
  out.tenants = out.tenants.map((r) => {
    const row: Record<string, unknown> = { ...r, id: to, slug: opts.asSlug || r.slug, name: opts.asName || r.name };
    for (const f of OLD_PLATFORM_FIELDS) delete row[f];
    return row;
  });
  return out;
}

export type Store = {
  select: (table: string, tenantId: string) => Promise<any[]>;
  /** Insert rows, skipping any whose primary key already exists; returns how many were new. */
  insertNew: (table: string, rows: any[]) => Promise<number>;
  stockSet: (tenantId: string, variantId: string, count: number, note: string) => Promise<void>;
  onHand: (tenantId: string, variantIds: string[]) => Promise<Record<string, number>>;
};

export async function exportTenant(src: Store, tenantId: string): Promise<Bundle> {
  const tables: Record<string, any[]> = {};
  for (const t of TRANSFER_TABLES) tables[t] = await src.select(t, tenantId);
  if (!tables.tenants.length) throw new Error('no tenant ' + tenantId + ' on the source');
  const stock = await src.onHand(tenantId, tables.product_variants.map((v) => v.id));
  const bundle: Bundle = { version: 1, exportedAt: new Date().toISOString(), tenantId, tables, stock, media: [] };
  bundle.media = mediaRefs(bundle);
  return bundle;
}

/** Plan (and with apply, do) the import; returns what it did or would do. */
export async function importTenant(dst: Store, bundle: Bundle, opts: TransferOptions, apply: boolean): Promise<string[]> {
  const rows = prepareRows(bundle, opts);
  const to = opts.asId || bundle.tenantId;
  const lines: string[] = [];
  for (const t of TRANSFER_TABLES) {
    const n = rows[t].length;
    if (!n) continue;
    if (!apply) { lines.push('would insert up to ' + n + ' ' + t + ' row(s) (existing ones are kept)'); continue; }
    const added = await dst.insertNew(t, rows[t]);
    lines.push(t + ': ' + added + ' new, ' + (n - added) + ' already there');
  }
  const variants = rows.product_variants.map((v) => v.id);
  const now = apply ? await dst.onHand(to, variants) : {};
  let set = 0;
  for (const v of variants) {
    const want = Number(bundle.stock[v] ?? 0);
    if (!apply) continue;
    if (Number(now[v] ?? 0) === want) continue;
    await dst.stockSet(to, v, want, 'transferred from ' + bundle.tenantId + ' (' + bundle.exportedAt.slice(0, 10) + ')');
    set++;
  }
  lines.push(apply ? 'stock: ' + set + ' variant count(s) set through stock_set (' + (variants.length - set) + ' already right)' : 'would set ' + variants.length + ' stock count(s) through stock_set');
  if (bundle.media.length) lines.push(bundle.media.length + ' photo(s) referenced: copy them with tenant-transfer.ts copy-media (keys are kept, so nothing is rewritten)');
  if (bundle.tables.tenants[0]?.stripe_account_id) lines.push('the Stripe connected account was NOT moved (it belongs to the old Stripe platform): the store reconnects from Settings → Payments');
  return lines;
}

/** The storage key behind a media reference ('' for anything not ours). */
export function mediaKeyOf(ref: string): string {
  const s = String(ref || '');
  const i = s.indexOf('/media/r2/');
  if (i >= 0) return decodeURIComponent(s.slice(i + '/media/r2/'.length).split('?')[0]);
  if (/^(tenants|products)\//.test(s)) return s;
  return '';
}

/** PostgREST store (service role), for the CLI. */
function restStore(url: string, key: string): Store {
  const h = { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  const base = url.replace(/\/+$/, '') + '/rest/v1/';
  const pk = (t: string) => (t === 'tenants' || t === 'tenant_store_config' ? (t === 'tenants' ? 'id' : 'tenant_id') : 'id');
  return {
    async select(t, id) {
      const col = t === 'tenants' ? 'id' : 'tenant_id';
      const r = await fetch(base + t + '?select=*&' + col + '=eq.' + id, { headers: h });
      if (!r.ok) throw new Error('read ' + t + ': ' + r.status);
      return r.json();
    },
    async insertNew(t, rows) {
      let n = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const r = await fetch(base + t + '?on_conflict=' + pk(t), { method: 'POST', headers: { ...h, prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(rows.slice(i, i + 200)) });
        if (!r.ok) throw new Error('write ' + t + ': ' + r.status + ' ' + (await r.text()).slice(0, 200));
        n += ((await r.json()) as any[]).length;
      }
      return n;
    },
    async stockSet(tenantId, variantId, count, note) {
      const r = await fetch(base + 'rpc/stock_set', { method: 'POST', headers: h, body: JSON.stringify({ p_tenant: tenantId, p_variant: variantId, p_count: count, p_actor: 'tenant-transfer', p_note: note }) });
      if (!r.ok) throw new Error('stock_set: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    },
    async onHand(tenantId, ids) {
      if (!ids.length) return {};
      const r = await fetch(base + 'inventory_levels?select=variant_id,quantity_available&tenant_id=eq.' + tenantId + '&variant_id=in.(' + ids.join(',') + ')', { headers: h });
      const rows: any[] = r.ok ? await r.json() : [];
      return Object.fromEntries(rows.map((x) => [x.variant_id, Number(x.quantity_available)]));
    },
  };
}

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
  return out;
}

if (process.argv[1] && /tenant-transfer\.ts$/.test(process.argv[1])) {
  const argv = process.argv.slice(2);
  const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
  (async () => {
    if (argv[0] === 'export') {
      const env = readEnvFile(join(process.cwd(), '.env.local'));
      const tenant = flag('--tenant');
      if (!/^[0-9a-f-]{36}$/.test(tenant)) throw new Error('--tenant <uuid>');
      const bundle = await exportTenant(restStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY), tenant);
      const out = flag('--out') || join('bootstrap-out', 'transfer', (bundle.tables.tenants[0].slug || tenant) + '.json');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(bundle, null, 2));
      console.log('exported ' + bundle.tables.tenants[0].slug + ': ' + TRANSFER_TABLES.map((t) => t + ' ' + bundle.tables[t].length).join(', ') + '; ' + Object.keys(bundle.stock).length + ' stock counts; ' + bundle.media.length + ' photos referenced -> ' + out);
    } else if (argv[0] === 'import') {
      const file = flag('--file'), envFile = flag('--env');
      if (!file || !existsSync(file)) throw new Error('--file <bundle.json>');
      if (!envFile || !existsSync(envFile)) throw new Error('--env <target env file> (the NEW install; .env.local is never used as a target)');
      const env = readEnvFile(envFile);
      const local = existsSync('.env.local') ? readEnvFile('.env.local') : {};
      if (local.SUPABASE_URL && env.SUPABASE_URL === local.SUPABASE_URL && !argv.includes('--same-project')) throw new Error('the target is the SOURCE project (.env.local): refusing (pass --same-project to copy within one install)');
      const bundle = JSON.parse(readFileSync(file, 'utf8')) as Bundle;
      const lines = await importTenant(restStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY), bundle, { asId: flag('--as-id') || undefined, asSlug: flag('--as-slug') || undefined, asName: flag('--as-name') || undefined }, argv.includes('--apply'));
      console.log((argv.includes('--apply') ? 'IMPORTED' : 'DRY RUN') + ' ' + bundle.tables.tenants[0]?.slug + ' -> ' + (flag('--as-slug') || bundle.tables.tenants[0]?.slug));
      for (const l of lines) console.log('  ' + l);
    } else if (argv[0] === 'copy-media') {
      // Photos: same keys in the target bucket, so no stored reference changes.
      const file = flag('--file'), envFile = flag('--env');
      if (!file || !existsSync(file) || !envFile || !existsSync(envFile)) throw new Error('copy-media --file <bundle.json> --env <target env> [--apply]');
      const { presignPut, presignGet } = await import('../../lib/media-s3');
      const wvars = (p: string) => { const out: Record<string, string> = {}; if (!existsSync(p)) return out; const src = readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, ''); for (const m of ((/"vars"\s*:\s*\{([\s\S]*?)\}/.exec(src)?.[1]) || '').matchAll(/"([A-Z0-9_]+)"\s*:\s*"([^"]*)"/g)) out[m[1]] = m[2]; return out; };
      const cfgOf = (e: Record<string, string>) => ({ accessKeyId: e.MEDIA_S3_ACCESS_KEY_ID, secretAccessKey: e.MEDIA_S3_SECRET_ACCESS_KEY, bucket: e.MEDIA_BUCKET || e.MEDIA_S3_BUCKET, region: e.MEDIA_S3_REGION || 'auto', endpoint: e.MEDIA_S3_ENDPOINT, publicBaseUrl: e.MEDIA_S3_PUBLIC_BASE_URL || '' });
      const source = cfgOf({ ...wvars('wrangler.jsonc'), ...readEnvFile('.env.local') });
      const target = cfgOf({ ...readEnvFile(envFile) });
      for (const [k, c] of [['source (.env.local + wrangler.jsonc)', source], ['target (' + envFile + ')', target]] as const) if (!c.accessKeyId || !c.secretAccessKey || !c.bucket || !c.endpoint) throw new Error(k + ' lacks MEDIA_S3_ACCESS_KEY_ID / MEDIA_S3_SECRET_ACCESS_KEY / MEDIA_BUCKET / MEDIA_S3_ENDPOINT');
      if (source.bucket === target.bucket && source.endpoint === target.endpoint) throw new Error('source and target are the same bucket');
      const bundle = JSON.parse(readFileSync(file, 'utf8')) as Bundle;
      const keys = [...new Set(bundle.media.map(mediaKeyOf).filter(Boolean))];
      let copied = 0, present = 0, missing = 0;
      for (const key of keys) {
        const have = await fetch(presignGet(target, key), { headers: { range: 'bytes=0-0' } });
        if (have.ok) { present++; continue; }
        if (!argv.includes('--apply')) { console.log('  would copy ' + key); continue; }
        const got = await fetch(presignGet(source, key));
        if (!got.ok) { missing++; console.log('  NOT FOUND on the source: ' + key); continue; }
        const put = await fetch(presignPut({ config: target, key, expiresSeconds: 900 }).uploadUrl, { method: 'PUT', headers: { 'content-type': got.headers.get('content-type') || 'application/octet-stream' }, body: new Uint8Array(await got.arrayBuffer()) as any });
        if (!put.ok) throw new Error('copy ' + key + ': ' + put.status);
        copied++;
      }
      console.log((argv.includes('--apply') ? 'COPIED ' + copied : 'DRY RUN') + ' of ' + keys.length + ' photo(s); ' + present + ' already in the target' + (missing ? '; ' + missing + ' missing on the source' : ''));
    } else {
      console.log('usage: export --tenant <id> | import --file <bundle> --env <target env> [--as-id] [--as-slug] [--as-name] [--apply] | copy-media --file <bundle> --env <target env> [--apply]');
      process.exit(2);
    }
  })().catch((e) => { console.error(String((e as Error).message || e)); process.exit(1); });
}
