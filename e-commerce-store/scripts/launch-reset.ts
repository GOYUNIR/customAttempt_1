/**
 * LAUNCH RESET — clear test and proof data from production, keeping what the
 * platform needs to run. Re-runnable; DRY RUN unless --apply.
 *
 *   npx tsx scripts/launch-reset.ts                 plan only (row counts), nothing changes
 *   npx tsx scripts/launch-reset.ts --apply         back up, then delete, then verify
 *   npx tsx scripts/launch-reset.ts --apply --proof-only
 *        only what proofs create (the release gate's last step): proof
 *        signups, sink mail, proof orders/customers in the fixture stores,
 *        proof accounts. No storage, no Stripe, kept stores' catalogs untouched.
 *
 * SAFETY NET: before anything is deleted, every table is exported as JSON
 * (API reads) plus the storage manifest and the auth-user list, into
 * launch-backups/<time>/ (gitignored).
 *
 * KEPT: schema; reference data (plans, provider_rates, email_provider_plans,
 * platform_policies, global_platform_settings, disposable_email_domains);
 * store_kv (live sessions and config); audit_logs (history); webhook_dedupe
 * (deleting it would let old Stripe events replay); the Resend send counts;
 * the GOYUNIR default-tenant shell (its config, no content); Demo Parfums with
 * its catalog; the two proof fixture stores with their catalogs: test4 (the
 * only Connect-enabled test store; a new one cannot be onboarded hands-free,
 * and its owner is the owner's own account) and goyunir-test-1 ("store B");
 * every account that is not a proof account (the owner's sign-in); brand
 * assets in storage (products/brand/, products/config/); all secrets.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';

const APPLY = process.argv.includes('--apply');
const PROOF_ONLY = process.argv.includes('--proof-only');
const QUIET = process.argv.includes('--quiet');
const log = (s: string) => { if (!QUIET) console.log(s); };

const DEFAULT = '00000000-0000-0000-0000-00000000000d';
const DEMO = '3b6f7db1-7645-4c52-aefe-cc8be563c359';
const FIXTURE_CONNECT = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const FIXTURE_B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de';       // goyunir-test-1
const KEPT_TENANTS = [DEFAULT, DEMO, FIXTURE_CONNECT, FIXTURE_B];
const BRAND_PREFIXES = ['products/brand/', 'products/config/'];
/** Proof and test email domains: anything here is never a real person. */
const PROOF_EMAIL = /@([a-z0-9-]+\.)*(invalid|test|example|localhost)$|@(example\.(com|net|org)|resend\.dev)$|@proof\.[a-z0-9.-]+$/i;

const REST = () => String(process.env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/';
const KEY = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY);
const H = () => ({ apikey: KEY(), authorization: 'Bearer ' + KEY() });

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(REST() + path, { ...init, headers: { ...H(), 'content-type': 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(init.method || 'GET' + ' ' + path.slice(0, 80) + ': ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function all(table: string, query = ''): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = await fetch(REST() + table + '?select=*' + (query ? '&' + query : ''), { headers: { ...H(), range: from + '-' + (from + 999) } }).then((r) => r.json());
    if (!Array.isArray(rows)) throw new Error('read ' + table + ': ' + JSON.stringify(rows).slice(0, 200));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const inq = (ids: string[]) => 'in.(' + ids.map((i) => '"' + String(i).replace(/"/g, '') + '"').join(',') + ')';
async function delIn(table: string, col: string, ids: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const rows = await rest(table + '?' + col + '=' + inq(chunk), { method: 'DELETE', headers: { prefer: 'return=representation' } });
    n += Array.isArray(rows) ? rows.length : 0;
  }
  return n;
}

type Step = { what: string; table: string; col: string; ids: string[] };

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  log('LAUNCH RESET ' + (APPLY ? 'APPLY' : 'DRY RUN') + (PROOF_ONLY ? ' (proof data only)' : '') + '  ' + stamp);

  // ── Read everything the plan depends on ────────────────────────────────
  const [tenants, orders, customers, users, signups, entries, invites, billing, holds, draws, alerts, products] = await Promise.all(
    ['tenants', 'orders', 'customers', 'users', 'merchant_signups', 'raffle_entries', 'staff_invites', 'tenant_billing_charges', 'stock_holds', 'drop_draws', 'alert_subscribers', 'products'].map((t) => all(t)));
  const custEmail = new Map(customers.map((c: any) => [c.id, String(c.email || '')]));
  const isProofCustomer = (c: any) => PROOF_EMAIL.test(String(c.email || ''));

  // Which rows go.
  const deadTenants = PROOF_ONLY ? [] : tenants.filter((t: any) => !KEPT_TENANTS.includes(t.id)).map((t: any) => t.id);
  const orderGoes = (o: any) => deadTenants.includes(o.tenant_id) || (PROOF_ONLY ? PROOF_EMAIL.test(custEmail.get(o.customer_id) || '') : true);
  const ordersGo = orders.filter(orderGoes);
  const customersGo = customers.filter((c: any) => deadTenants.includes(c.tenant_id) || (PROOF_ONLY ? isProofCustomer(c) : true));
  const proofUser = (u: any) => PROOF_EMAIL.test(String(u.email || ''));
  // Accounts: proof accounts only, never the fixture owners (store B's owner is a proof address but owns a kept store).
  const fixtureOwnerIds = new Set(users.filter((u: any) => [FIXTURE_CONNECT, FIXTURE_B, DEMO].includes(u.tenant_id) && u.role === 'owner').map((u: any) => u.id));
  const usersGo = users.filter((u: any) => proofUser(u) && !fixtureOwnerIds.has(u.id) || deadTenants.includes(u.tenant_id) && proofUser(u));
  // Products the proofs make in the fixture stores (they never remove them
  // themselves): "Isolation B Tee <run>", "Form Made Cap <run>", "Photo proof B <run>".
  const PROOF_PRODUCT = /^(Isolation B Tee|Form Made Cap|Photo proof B) [a-z0-9]+$/i;
  const proofProduct = (p: any) => [FIXTURE_CONNECT, FIXTURE_B].includes(p.tenant_id) && PROOF_PRODUCT.test(String(p.name || ''));
  const productsGo = products.filter((p: any) => proofProduct(p) || (!PROOF_ONLY && (p.tenant_id === DEFAULT || deadTenants.includes(p.tenant_id))));

  const plan: Step[] = [
    { what: 'billing rows of removed orders (billing keeps a row when its order goes)', table: 'tenant_billing_charges', col: 'payment_intent_id', ids: billing.filter((b: any) => ordersGo.some((o: any) => o.stripe_payment_intent_id === b.payment_intent_id) || deadTenants.includes(b.tenant_id)).map((b: any) => b.payment_intent_id) },
    { what: 'orders (lines and fulfilments go with them)', table: 'orders', col: 'id', ids: ordersGo.map((o: any) => o.id) },
    { what: 'raffle and waitlist entries', table: 'raffle_entries', col: 'id', ids: entries.filter((e: any) => PROOF_ONLY ? PROOF_EMAIL.test(String(e.email || '')) : true).map((e: any) => e.id) },
    { what: 'draw records', table: 'drop_draws', col: 'id', ids: PROOF_ONLY ? [] : draws.map((d: any) => d.id) },
    { what: 'stock holds', table: 'stock_holds', col: 'id', ids: (PROOF_ONLY ? holds.filter((h: any) => [FIXTURE_CONNECT, FIXTURE_B].includes(h.tenant_id) && h.status !== 'active') : holds).map((h: any) => h.id) },
    { what: 'customers', table: 'customers', col: 'id', ids: customersGo.map((c: any) => c.id) },
    { what: 'release-list subscribers', table: 'alert_subscribers', col: 'id', ids: alerts.filter((a: any) => PROOF_ONLY ? PROOF_EMAIL.test(String(a.email || '')) : true).map((a: any) => a.id) },
    { what: 'staff invites', table: 'staff_invites', col: 'id', ids: invites.filter((i: any) => PROOF_ONLY ? PROOF_EMAIL.test(String(i.email || '')) : true).map((i: any) => i.id) },
    { what: 'self-serve signups (all from proofs)', table: 'merchant_signups', col: 'id', ids: signups.filter((s: any) => PROOF_ONLY ? PROOF_EMAIL.test(String(s.email || '')) : true).map((s: any) => s.id) },
    { what: 'products: proof-made ones in the fixtures, plus (full reset) the GOYUNIR shell and removed stores', table: 'products', col: 'id', ids: productsGo.map((p: any) => p.id) },
    { what: 'proof accounts (staff rows)', table: 'users', col: 'id', ids: usersGo.map((u: any) => u.id) },
    { what: 'stores not kept', table: 'tenants', col: 'id', ids: deadTenants },
  ];
  const sink = await all('email_sink', 'select=id');
  const usage = PROOF_ONLY ? [] : await all('usage_events', 'select=id');
  const sinkCounts = await all('email_send_counts', 'provider=eq.sink');
  plan.push({ what: 'recorded proof mail (email_sink)', table: 'email_sink', col: 'id', ids: sink.map((s: any) => s.id) });
  // Platform leads: proof leads always; a full reset clears every test lead.
  const leads = await all('platform_leads', 'select=id,email');
  plan.push({ what: 'platform leads' + (PROOF_ONLY ? ' (proof addresses)' : ''), table: 'platform_leads', col: 'id', ids: leads.filter((l: any) => !PROOF_ONLY || PROOF_EMAIL.test(String(l.email || ''))).map((l: any) => l.id) });
  plan.push({ what: 'usage ledger rows (all test traffic)', table: 'usage_events', col: 'id', ids: usage.map((u: any) => u.id) });

  // Storage: objects nothing kept refers to (brand assets always kept).
  const { readMediaS3Config, presignList, presignDelete } = await import('../lib/media-s3');
  const cfg = PROOF_ONLY ? null : readMediaS3Config();
  let storageKeys: string[] = [];
  if (cfg) {
    let token = '';
    do {
      const xml = await (await fetch(presignList(cfg, { continuationToken: token || undefined }))).text();
      storageKeys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, '&')));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? ((/<NextContinuationToken>([^<]+)</.exec(xml) || [])[1] || '') : '';
    } while (token);
  }
  const keptProducts = products.filter((p: any) => !productsGo.some((g: any) => g.id === p.id));
  const referenced = new Set<string>();
  const base = String(process.env.MEDIA_S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  for (const p of keptProducts) for (const m of (p.media_gallery || []) as any[]) {
    const u = String(m?.url || '');
    if (u.startsWith('media:')) referenced.add(u.slice(6)); else if (base && u.startsWith(base + '/')) referenced.add(u.slice(base.length + 1).split('?')[0]);
  }
  const storageGo = storageKeys.filter((k) => !BRAND_PREFIXES.some((p) => k.startsWith(p)) && !referenced.has(k));

  // Auth accounts that go with the proof staff rows (and proof auth users with no row).
  const sc = await import('../services/config/supabase-client');
  const authList: any[] = ((await sc.supabaseAuthFetch('/admin/users?per_page=1000', { key: KEY() })) as any)?.users || [];
  const keepIds = new Set(users.filter((u: any) => !usersGo.some((g: any) => g.id === u.id)).map((u: any) => u.id));
  const authGo = authList.filter((a) => PROOF_EMAIL.test(String(a.email || '')) && !keepIds.has(a.id));

  // ── The plan ───────────────────────────────────────────────────────────
  log('\nPLAN');
  for (const s of plan) log('  ' + String(s.ids.length).padStart(5) + '  ' + s.table.padEnd(24) + s.what);
  log('  ' + String(sinkCounts.length).padStart(5) + '  ' + 'email_send_counts'.padEnd(24) + 'the sink provider\'s counters (real providers\' counts kept)');
  log('  ' + String(authGo.length).padStart(5) + '  ' + 'auth users'.padEnd(24) + 'proof sign-in accounts (the owner\'s accounts are never on a proof domain)');
  log('  ' + String(storageGo.length).padStart(5) + '  ' + 'storage objects'.padEnd(24) + 'not referenced by any kept product (of ' + storageKeys.length + '; brand assets kept)');
  log('\nKEPT stores: ' + tenants.filter((t: any) => !deadTenants.includes(t.id)).map((t: any) => t.slug).join(', ') + '; accounts kept: ' + (users.length - usersGo.length));
  if (!APPLY) { log('\nDRY RUN: nothing changed. Re-run with --apply.'); return; }

  // ── Safety net: export first ───────────────────────────────────────────
  const dir = join(process.cwd(), 'launch-backups', stamp);
  mkdirSync(dir, { recursive: true });
  const spec: any = await fetch(REST(), { headers: { ...H(), accept: 'application/openapi+json' } }).then((r) => r.json());
  const tables = Object.keys(spec.definitions || {}).sort();
  const manifest: Record<string, number> = {};
  for (const t of tables) { const rows = await all(t); writeFileSync(join(dir, t + '.json'), JSON.stringify(rows)); manifest[t] = rows.length; }
  writeFileSync(join(dir, '_auth_users.json'), JSON.stringify(authList.map((a) => ({ id: a.id, email: a.email, created_at: a.created_at }))));
  writeFileSync(join(dir, '_storage_keys.json'), JSON.stringify(storageKeys));
  writeFileSync(join(dir, '_manifest.json'), JSON.stringify({ stamp, proofOnly: PROOF_ONLY, rows: manifest, plan: plan.map((s) => ({ table: s.table, rows: s.ids.length })), storageGo: storageGo.length, authGo: authGo.length }, null, 2));
  log('\nBACKUP  ' + tables.length + ' tables, ' + authList.length + ' auth users, ' + storageKeys.length + ' storage keys -> ' + dir);

  // ── Apply (children first) ─────────────────────────────────────────────
  log('\nAPPLY');
  for (const s of plan) if (s.ids.length) log('  ' + String(await delIn(s.table, s.col, s.ids)).padStart(5) + '  ' + s.table);
  if (sinkCounts.length) { await rest('email_send_counts?provider=eq.sink', { method: 'DELETE' }); log('  ' + String(sinkCounts.length).padStart(5) + '  email_send_counts (sink)'); }
  let authDone = 0;
  for (const a of authGo) { const r = await fetch(String(process.env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/admin/users/' + a.id, { method: 'DELETE', headers: H() }); if (r.ok) authDone++; }
  if (authGo.length) log('  ' + String(authDone).padStart(5) + '  auth users');
  let objDone = 0;
  for (const k of storageGo) { const r = await fetch(presignDelete(cfg!, k), { method: 'DELETE' }); if (r.ok || r.status === 204) objDone++; }
  if (storageGo.length) log('  ' + String(objDone).padStart(5) + '  storage objects');

  // ── Verify ─────────────────────────────────────────────────────────────
  log('\nVERIFY');
  let bad = 0;
  const check = (ok: boolean, what: string) => { log('  ' + (ok ? 'PASS ' : 'FAIL ') + what); if (!ok) bad++; };
  for (const s of plan) if (s.ids.length) check((await all(s.table, s.col + '=' + inq(s.ids.slice(0, 100)))).length === 0, s.table + ': removed rows are gone');
  const tAfter = await all('tenants');
  check(KEPT_TENANTS.every((id) => tAfter.some((t: any) => t.id === id)), 'kept stores still exist (GOYUNIR shell, demo, both fixtures)');
  for (const ref of ['plans', 'provider_rates', 'email_provider_plans', 'platform_policies', 'global_platform_settings', 'disposable_email_domains']) check((await all(ref, 'select=*&limit=1')).length > 0, ref + ' intact');
  const uAfter = await all('users');
  check(uAfter.filter((u: any) => !PROOF_EMAIL.test(String(u.email || ''))).length === users.filter((u: any) => !PROOF_EMAIL.test(String(u.email || ''))).length, 'every non-proof account kept (the owner\'s sign-in)');
  check(uAfter.every((u: any) => !u.tenant_id || tAfter.some((t: any) => t.id === u.tenant_id)), 'no account points at a removed store');
  const resendCounts = await all('email_send_counts', 'provider=eq.resend');
  check(resendCounts.length > 0 || !(await all('email_send_counts')).length, 'real provider send counts kept');
  log('\n' + (bad ? 'RESET FINISHED WITH ' + bad + ' FAILED CHECK(S)' : 'RESET DONE, ALL CHECKS PASS') + '  (backup: ' + dir + ')');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
