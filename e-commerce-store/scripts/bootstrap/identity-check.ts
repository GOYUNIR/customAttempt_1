/**
 * IDENTITY CHECK (OWNERSHIP-MIGRATION.md): after a move or a rename, no
 * platform-facing surface may still carry the OLD identity: the old name,
 * domain, operator, support or alert address. Fails listing each hit.
 *
 * Platform-facing = what a stranger or a merchant sees from the PLATFORM:
 *   pages     marketing home, terms, privacy, signup status, the staff and
 *             merchant sign-in pages (admin./sales./app.), robots, sitemap
 *   emails    the platform's own emails (sign-in code, staff invite, signup
 *             verify, existing-account notice, operator alert), rendered
 *             through the record-mode stub (never sent) and read back
 *   config    the generated Worker config (old roots may appear ONLY as
 *             PLATFORM_OLD_ROOT_DOMAINS and their routes)
 * Stores' own pages are NOT platform-facing (a store keeps its own name,
 * the original shop included).
 *
 *   npx tsx scripts/bootstrap/identity-check.ts --old "OldName,old.example,ops@old.example" \
 *       [--base https://new.example] [--host new.example] [--no-emails] [--config bootstrap-out/<d>/wrangler.jsonc]
 * --host sends that Host header to --base (a local dev server rehearsing a name).
 * Emails render with THIS process's identity env (PLATFORM_NAME, PLATFORM_ROOT_DOMAIN,
 * SUPPORT_EMAIL, RESEND_FROM...): run it with the new identity's values.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const OLD = flag('--old').split(',').map((s) => s.trim()).filter(Boolean);
if (!OLD.length) { console.error('usage: --old "<old name>,<old domain>,<old addresses>…" (what must be gone)'); process.exit(2); }

const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';

// The identity the checked surfaces should carry: the Worker config's vars
// (--config, else this repo's wrangler.jsonc), unless already in the env.
{
  const file = flag('--config') || join(process.cwd(), 'wrangler.jsonc');
  if (existsSync(file)) {
    const src = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const block = /"vars"\s*:\s*\{([\s\S]*?)\}/.exec(src)?.[1] || '';
    for (const m of block.matchAll(/"([A-Z0-9_]+)"\s*:\s*"([^"]*)"/g)) if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const ROOT = (flag('--host') || String(process.env.PLATFORM_ROOT_DOMAIN || '')).toLowerCase();
if (!ROOT) { console.error('no platform root domain (set PLATFORM_ROOT_DOMAIN, --config or --host)'); process.exit(2); }
let unchecked = 0;
const BASE = flag('--base') || 'https://' + ROOT;
const hits: string[] = [];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Each old value, matched case-insensitively and as a whole token. */
const OLD_RES = OLD.map((v) => ({ v, re: new RegExp('(^|[^a-z0-9])' + escape(v) + '($|[^a-z0-9])', 'i') }));
/**
 * Code identifiers built from the old name (CSS classes, storage keys, element
 * ids such as "goyunir-mkt-nav", "goyunir_admin_device") are not identity a
 * person sees: listed separately (RELEASE-PLAN, after launch), not failures.
 * Everything else, visible text, titles, links, addresses, emails, fails.
 */
const identifiers = new Map<string, number>();
const IDENT_RES = OLD.filter((v) => /^[a-z0-9]+$/i.test(v)).map((v) => new RegExp(escape(v) + '[-_][a-z0-9][a-z0-9_-]*', 'gi'));
export function findOld(where: string, text: string, out: string[]) {
  let t = text;
  for (const re of IDENT_RES) t = t.replace(re, (id) => { identifiers.set(id.toLowerCase(), (identifiers.get(id.toLowerCase()) || 0) + 1); return ' '; });
  for (const { v, re } of OLD_RES) {
    const m = re.exec(t);
    if (m) out.push(where + ': "' + v + '" … ' + JSON.stringify(t.slice(Math.max(0, m.index - 40), m.index + v.length + 40).replace(/\s+/g, ' ')));
  }
}

/** A page, following up to 3 redirects (each hop's Location is checked too). */
async function page(host: string, path: string) {
  let text = '';
  let status = 0;
  for (let hop = 0; hop < 4; hop++) {
    const url = flag('--host') ? BASE.replace(/\/+$/, '') + path : 'https://' + host + path;
    // Local rehearsal: wrangler dev answers as the first route's host, so the
    // host this request means also goes in x-forwarded-host (trusted there only).
    const r = await fetch(url, { headers: flag('--host') ? { host, 'x-forwarded-host': host } : {}, redirect: 'manual' });
    status = r.status;
    const location = r.headers.get('location') || '';
    text += ' ' + location + ' ' + (await r.text());
    if (status < 300 || status >= 400 || !location) break;
    const next = new URL(location, 'https://' + host);
    host = next.host;
    path = next.pathname + next.search;
  }
  return { status, text, location: host + path };
}

(async () => {
  console.log('IDENTITY CHECK  platform root ' + ROOT + '  old values: ' + OLD.length);
  console.log('\nPages');
  const pages: Array<[string, string]> = [
    [ROOT, '/'], [ROOT, '/terms'], [ROOT, '/privacy'], [ROOT, '/platform/signup-status'], [ROOT, '/robots.txt'], [ROOT, '/sitemap.xml'],
    ['admin.' + ROOT, '/admin/login'], ['sales.' + ROOT, '/sales'], ['app.' + ROOT, '/app'],
  ];
  for (const [host, path] of pages) {
    try {
      const r = await page(host, path);
      const before = hits.length;
      findOld(host + path, r.text + ' ' + r.location, hits);
      console.log('  ' + (hits.length > before ? 'OLD ' : 'ok  ') + String(r.status).padEnd(4) + host + path + (r.location !== host + path ? '  -> ' + r.location : ''));
    } catch (e) {
      unchecked++;
      console.log('  ??  ' + host + path + ' could not be checked (' + String((e as Error).message).slice(0, 80) + ')');
    }
  }

  if (!argv.includes('--no-emails')) {
    console.log('\nPlatform emails (record-mode stub: rendered, never sent)');
    process.env.EMAIL_DRIVER = 'record';
    const email = await import('../../lib/email');
    const { getDb } = await import('../../lib/db/client');
    const { eq } = await import('../../lib/db/query');
    const run = Date.now().toString(36);
    const to = 'identity-' + run + '@identity.invalid';
    const sends: Array<[string, () => Promise<unknown>]> = [
      ['sign-in code', () => email.sendAdminVerificationEmail({ to, code: '123456' })],
      ['staff invite', () => email.sendStaffInviteEmail({ to, role: 'sales', invitedBy: 'someone@identity.invalid', acceptUrl: 'https://' + ROOT + '/accept', expiresInDays: 7 } as any)],
      ['signup verify', () => email.sendSignupVerifyEmail({ to, storeName: 'Identity Probe', url: 'https://' + ROOT + '/verify', holdHours: 48 })],
      ['existing account', () => email.sendSignupExistingAccountEmail({ to, signInUrl: 'https://app.' + ROOT + '/app' })],
    ];
    for (const [what, send] of sends) {
      try { await send(); } catch (e) { unchecked++; console.log('  ??  ' + what + ' could not render: ' + String((e as Error).message).slice(0, 80)); }
    }
    // The operator alert goes to the alert inbox, not `to`: render it the same way.
    const alertTo = String(process.env.OPERATOR_ALERT_EMAIL || process.env.SUPPORT_EMAIL || '');
    findOld('operator alert address (OPERATOR_ALERT_EMAIL / SUPPORT_EMAIL)', alertTo, hits);
    const rows = (await getDb().select<any>('email_sink', { where: { to_address: eq(to) }, select: ['subject', 'from_address', 'reply_to', 'html'] })) as any[];
    for (const r of rows) {
      const before = hits.length;
      findOld('email "' + String(r.subject).slice(0, 50) + '"', [r.subject, r.from_address, r.reply_to, r.html].join(' '), hits);
      console.log('  ' + (hits.length > before ? 'OLD ' : 'ok  ') + String(r.subject).slice(0, 70));
    }
    if (rows.length < sends.length) { unchecked += sends.length - rows.length; console.log('  ?? only ' + rows.length + ' of ' + sends.length + ' emails were recorded'); }
    await getDb().remove('email_sink', { where: { to_address: eq(to) } }).catch(() => null);
  }

  const cfg = flag('--config');
  if (cfg) {
    console.log('\nWorker config ' + cfg);
    const c = JSON.parse(readFileSync(cfg, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    const oldRoots = String(c.vars?.PLATFORM_OLD_ROOT_DOMAINS || '').split(',').filter(Boolean);
    const vars = Object.entries<string>(c.vars || {}).filter(([k]) => k !== 'PLATFORM_OLD_ROOT_DOMAINS');
    const routes = (c.routes || []).filter((r: any) => !oldRoots.some((d) => r.zone_name === d));
    const before = hits.length;
    findOld('config', JSON.stringify({ name: c.name, vars, routes, r2: c.r2_buckets }), hits);
    console.log('  ' + (hits.length > before ? 'OLD values in the config' : 'ok'));
  }

  if (identifiers.size) console.log('\nCode identifiers built from an old name (not visible identity; renamed after launch): ' + [...identifiers.keys()].sort().join(', '));
  console.log('\n' + (hits.length ? hits.length + ' OLD-IDENTITY HIT(S):' : unchecked ? unchecked + ' SURFACE(S) COULD NOT BE CHECKED: not clean until they are' : 'IDENTITY CLEAN: no old value on any platform-facing surface'));
  for (const h of hits) console.log('  ' + h);
  process.exit(hits.length || unchecked ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
