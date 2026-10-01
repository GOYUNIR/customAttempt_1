/**
 * CUSTOM DOMAINS — isolation and rules proof, live (STORE-ADDRESSES.md §B).
 *
 *   npx tsx scripts/verify-custom-domains.ts
 *
 * Until the owner switches on Cloudflare for SaaS, no real custom hostname can
 * reach the Worker. So the routing half writes run-unique hostnames under
 * `.proof.invalid` (never real DNS) straight into tenant_domains, standing in
 * for "Cloudflare live + TXT proven", and checks what the platform does with
 * them; the gate half runs through the live routes. Everything written is
 * removed at the end.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = 'true';
// The host-routing half calls the platform's own lookup in this process, so
// it must see production's routing settings (wrangler.jsonc vars; they are not
// in .env.local). Without a root the platform runs single-domain and every
// host is the original store — which is how this proof first failed.
process.env.PLATFORM_ROOT_DOMAIN = process.env.PLATFORM_ROOT_DOMAIN || 'goyunir.com';
process.env.STOREFRONT_LEGACY_HOSTS = process.env.STOREFRONT_LEGACY_HOSTS || 'shop,www,api,goyunir';

const APP = 'https://app.goyunir.com';
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4 (payments connected)
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1 (not connected)
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { storefrontTenantForHost, storefrontTenantForRequest } = await import('../lib/storefront-tenant');
  const db = getDb(); const kv: any = createKvClient();
  const ownerA = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sA = (await issueAdminDevice(kv, ownerA, false, deviceMetaFor((await readStaffIdentity(ownerA))!), 900)).token;
  const sB = (await issueAdminDevice(kv, B_OWNER, false, deviceMetaFor((await readStaffIdentity(B_OWNER))!), 900)).token;
  const h = (tok: string, json = false) => ({ origin: APP, cookie: 'goyunir_admin_device=' + tok, ...(json ? { 'content-type': 'application/json' } : {}) });
  const add = async (tok: string, hostname: string) => { const r = await fetch(APP + '/api/merchant/domains', { method: 'POST', headers: h(tok, true), body: JSON.stringify({ hostname }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const HA = 'a-' + run + '.proof.invalid', HB = 'b-' + run + '.proof.invalid', HP = 'pending-' + run + '.proof.invalid', HB2 = 'b2-' + run + '.proof.invalid';
  const rows = [HA, HB, HP, HB2];
  const live = (hostname: string, tenant: string, extra: Record<string, unknown> = {}) => db.insert('tenant_domains', {
    hostname, tenant_id: tenant, verify_token: 'sv-proof-' + run, status: 'active', ssl_status: 'active', ownership_verified_at: new Date().toISOString(), ...extra,
  }, { returning: 'minimal' } as any);

  try {
    console.log('\nGates (live routes)');
    const v0: any = await (await fetch(APP + '/api/merchant/domains', { headers: h(sA) })).json();
    check(v0.plan === 'Free' && v0.limit === 1 && v0.used === 0, 'test4 sees its plan\'s cap from plan data: ' + JSON.stringify({ plan: v0.plan, limit: v0.limit, used: v0.used }));
    const root = await add(sA, 'example.com');
    check(root.status === 400 && /www\.example\.com/.test(root.body?.error), 'a bare root domain gets the www suggestion: ' + root.body?.error);
    const plat = await add(sA, 'demo.goyunir.com');
    check(plat.status === 400 && /belongs to the platform/.test(plat.body?.error), 'a platform address cannot be claimed: ' + plat.body?.error);
    const noPay = await add(sB, 'www.store-b-' + run + '.example');
    check(noPay.status === 409 && /Connect payments first/.test(noPay.body?.error), 'a store without verified payments gets no domain: ' + noPay.body?.error);
    const notOn = await add(sA, 'www.store-a-' + run + '.example');
    check(notOn.status === 503 && /not switched on yet/.test(notOn.body?.error), 'with Cloudflare not set up, the answer says so plainly: ' + notOn.body?.error);
    check(((await db.select<any>('tenant_domains', { where: { tenant_id: eq(A) }, select: ['hostname'] })) as any[]).length === 0, 'and nothing was written');
    await live(HA, A);
    const capped = await add(sA, 'www.second-' + run + '.example');
    check(capped.status === 409 && /includes 1 custom domain/.test(capped.body?.error), 'the Free cap (1) is enforced: ' + capped.body?.error);

    console.log('\nRouting: a host serves exactly its own store');
    await live(HB, B);
    await db.insert('tenant_domains', { hostname: HP, tenant_id: A, verify_token: 'sv-proof', status: 'pending', ssl_status: 'pending' }, { returning: 'minimal' } as any);
    const ta = await storefrontTenantForHost(HA), tb = await storefrontTenantForHost(HB);
    check(ta.kind === 'store' && ta.tenantId === A, HA + ' → test4');
    check(tb.kind === 'store' && tb.tenantId === B, HB + ' → store B, never test4');
    check((await storefrontTenantForHost(HP)).kind === 'none', 'a pending (unverified) domain serves nothing');
    check((await storefrontTenantForHost('unknown-' + run + '.proof.invalid')).kind === 'none', 'an unknown domain serves nothing');
    const forged = await storefrontTenantForRequest(new Request('https://' + HA + '/', { headers: { host: HA, 'x-forwarded-host': HB } }));
    check(forged.kind === 'store' && forged.tenantId === A, 'a forged x-forwarded-host (store B\'s domain) on store A\'s Host is ignored: still test4');
    check((await db.insert('tenant_domains', { hostname: HA, tenant_id: B, verify_token: 'x' }, { returning: 'minimal' } as any).then(() => false, () => true)), 'store B cannot claim test4\'s hostname (one hostname, one store)');

    console.log('\nPrimary domain');
    await db.update('tenant_domains', { where: { hostname: eq(HA) } }, { is_primary: true }, { returning: 'minimal' } as any);
    let loc = ''; let canonical = '';
    for (let i = 0; i < 18 && !loc.startsWith('https://' + HA); i++) {
      const res = await fetch('https://test4.goyunir.com/connect-test-item', { redirect: 'manual' });
      loc = String(res.headers.get('location') || '');
      if (!loc.startsWith('https://' + HA)) await sleep(5000);
    }
    check(loc === 'https://' + HA + '/connect-test-item', 'with a live primary domain, the store\'s own address 301s there, same path: ' + loc);
    await db.update('tenant_domains', { where: { hostname: eq(HA) } }, { is_primary: false }, { returning: 'minimal' } as any);

    console.log('\nDowngrade: domains above the cap are released');
    await live(HB2, B, { created_at: new Date(Date.now() + 1000).toISOString() });
    await db.update('tenant_domains', { where: { hostname: eq(HB) } }, { is_primary: true }, { returning: 'minimal' } as any);
    const vb: any = await (await fetch(APP + '/api/merchant/domains', { headers: h(sB) })).json();
    const left = ((await db.select<any>('tenant_domains', { where: { tenant_id: eq(B) }, select: ['hostname'] })) as any[]).map((r) => r.hostname);
    check(vb.used === 1 && left.length === 1 && left[0] === HB, 'store B on Free had 2: the newer one was released, the main one kept: ' + JSON.stringify(left));

    console.log('\nHTTPS only');
    const http = await fetch('http://demo.goyunir.com/salt-meridian', { redirect: 'manual' });
    check([301, 302, 307, 308].includes(http.status) && String(http.headers.get('location')).startsWith('https://demo.goyunir.com/salt-meridian'), 'plain HTTP is redirected to HTTPS: ' + http.status + ' → ' + http.headers.get('location'));
  } finally {
    for (const hn of rows) await db.remove('tenant_domains', { where: { hostname: eq(hn) } }).catch(() => null);
    console.log('\ncleanup: proof hostnames removed (' + rows.length + ')');
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
