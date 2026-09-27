/**
 * MERCHANT DASHBOARD ISOLATION PROOF (TENANCY.md, lib/merchant-session.ts).
 *
 *   npx tsx scripts/verify-merchant-isolation.ts
 *
 * Two real merchant owners of two different stores — test4, and goyunir-test-1
 * (whose owner is created through the REAL invite + accept-invite flow on
 * production, once) — plus the original store's own admin session and no
 * session at all, against every /api/merchant route on production. Sessions
 * are issued exactly as the verified sign-in issues them, live 10 minutes,
 * and are deleted at the end. Checks:
 *   each store sees ONLY itself (store, catalog, orders) and never the
 *   original store; writes land only in the session's store; another store's
 *   product can't be edited; a tenant id in the body is ignored; the wrong
 *   sessions are refused; revocation is immediate; host fences and CSRF hold;
 *   the admin tree still refuses a merchant.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';

const APP = 'https://app.goyunir.com';
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient, loadProducts } = await import('../lib/server-config');
  const { ADMIN_DEVICES_KEY } = await import('../lib/redis-keys');
  const { createInvite } = await import('../lib/staff-invites');
  const { DEFAULT_TENANT_ID } = await import('../lib/default-tenant');
  const kv: any = createKvClient();
  const db = getDb();

  // ── store B's owner, through the real invite flow (once) ──────────────────
  if (!(await readStaffIdentity(B_OWNER))) {
    const inv: any = await createInvite({ email: B_OWNER, role: 'owner', tenantId: B, invitedByEmail: 'isolation-proof@goyunir.invalid' });
    if (!inv.ok) throw new Error('invite failed: ' + inv.message);
    const res = await fetch(APP + '/api/admin/accept-invite', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: APP },
      body: JSON.stringify({ token: inv.token, password: 'Iso-' + crypto.randomUUID() + '-Aa1!' }),
    });
    console.log('store B owner created through the real accept-invite route: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
  }
  const aOwner = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const idA = await readStaffIdentity(aOwner);
  const idB = await readStaffIdentity(B_OWNER);
  if (!idA || !idB || idB.tenantId !== B) throw new Error('owners not ready: ' + JSON.stringify({ a: idA?.tenantId, b: idB?.tenantId }));

  const sA = (await issueAdminDevice(kv, aOwner, false, deviceMetaFor(idA), 600)).token;
  const sB = (await issueAdminDevice(kv, B_OWNER, false, deviceMetaFor(idB), 600)).token;
  const sOwn = (await issueAdminDevice(kv, 'isolation-own-admin@goyunir.invalid', false, {}, 600)).token;
  const call = async (path: string, token: string | null, init: RequestInit = {}, base = APP) => {
    const headers: Record<string, string> = { ...(init.headers as any || {}) };
    if (token) headers.cookie = 'goyunir_admin_device=' + token;
    if (init.method && init.method !== 'GET' && !headers.origin) headers.origin = base;
    const res = await fetch(base + path, { ...init, headers });
    let body: any = null; try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };
  const post = (token: string | null, payload: any, extra: Record<string, string> = {}) =>
    call('/api/merchant/products', token, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(payload) });
  const defaultNames = async () => Object.values(await loadProducts(null, { tenantId: DEFAULT_TENANT_ID } as any)).map((p: any) => p.name).sort().join('|');
  const defaultBefore = (await db.select<any>('products', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['id', 'name', 'updated_at'] })) as any[];

  try {
    console.log('\n/api/merchant/store');
    const stA = await call('/api/merchant/store', sA);
    const stB = await call('/api/merchant/store', sB);
    check(stA.status === 200 && stA.body?.store?.slug === 'test4', 'test4 owner sees test4: ' + JSON.stringify(stA.body?.store));
    check(stB.status === 200 && stB.body?.store?.slug === 'goyunir-test-1', 'store B owner sees store B: ' + JSON.stringify(stB.body?.store));
    const own = await call('/api/merchant/store', sOwn);
    const none = await call('/api/merchant/store', null);
    check(own.status === 403 && own.body?.code === 'NOT_A_MERCHANT_SESSION', 'the original store\'s own admin session is not a merchant session: ' + own.status);
    check(none.status === 401, 'no session: ' + none.status);

    console.log('\n/api/merchant/products (read)');
    const pA = await call('/api/merchant/products', sA);
    const pB = await call('/api/merchant/products', sB);
    const namesA = (pA.body?.products || []).map((p: any) => p.name);
    const namesB = (pB.body?.products || []).map((p: any) => p.name);
    check(pA.status === 200 && namesA.includes('Connect Test Item') && !namesA.some((n: string) => /Black Solstice|Roccstar/.test(n)), 'test4 sees its own catalog only: ' + namesA.join(', '));
    check(pB.status === 200 && !namesB.some((n: string) => /Connect Test|Black Solstice|Roccstar/.test(n)), 'store B sees none of test4\'s or the original store\'s products: [' + namesB.join(', ') + ']');

    console.log('\n/api/merchant/products (write)');
    const run = Date.now().toString(36);
    const created = await post(sB, { name: 'Isolation B Tee ' + run, slug: 'iso-b-' + run, sizes: [{ size: 'M', price: 21, mode: 'FCFS', stock: 4 }], tenantId: A, tenant_id: A });
    check(created.status === 201, 'store B creates a product (with a tenant id for test4 smuggled into the body): ' + created.status);
    const newId = created.body?.product?.id;
    const row = newId ? ((await db.select<any>('products', { where: { external_id: eq(newId) }, select: ['tenant_id', 'name'] })) as any[]) : [];
    check(row.length === 1 && row[0].tenant_id === B, 'it was written to store B only (the body\'s tenant id was ignored): ' + JSON.stringify(row));
    const pA2 = await call('/api/merchant/products', sA);
    check(!(pA2.body?.products || []).some((p: any) => p.id === newId), 'test4 does not see store B\'s new product');
    const aItem = (pA.body?.products || []).find((p: any) => p.id === 'prod_tenant_test_1');
    const hijack = await post(sB, { id: 'prod_tenant_test_1', name: 'HIJACKED', slug: 'connect-test-item', sizes: [{ size: 'One Size', price: 1, mode: 'FCFS' }] });
    check(hijack.status === 404, 'store B cannot edit test4\'s product by its id: ' + hijack.status + ' ' + JSON.stringify(hijack.body));
    const aItemAfter = ((await call('/api/merchant/products', sA)).body?.products || []).find((p: any) => p.id === 'prod_tenant_test_1');
    check(JSON.stringify(aItem) === JSON.stringify(aItemAfter), 'test4\'s product is unchanged');
    const dup = await post(sA, { name: 'Dup', slug: 'connect-test-item', sizes: [{ size: 'X', price: 5, mode: 'FCFS' }] });
    check(dup.status === 409, 'a new product cannot take an existing web address in the same store: ' + dup.status);
    const defaultAfter = (await db.select<any>('products', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['id', 'name', 'updated_at'] })) as any[];
    check(JSON.stringify(defaultAfter) === JSON.stringify(defaultBefore), 'the original store\'s catalog rows are byte-identical before and after (' + defaultAfter.length + ' products)');

    console.log('\n/api/merchant/orders');
    const oA = await call('/api/merchant/orders', sA);
    const oB = await call('/api/merchant/orders', sB);
    const dbA = ((await db.select<any>('orders', { where: { tenant_id: eq(A) }, select: ['order_ref'] })) as any[]).map((o) => o.order_ref).sort();
    const dbDefault = new Set(((await db.select<any>('orders', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['order_ref'] })) as any[]).map((o) => o.order_ref));
    const refsA = (oA.body?.orders || []).map((o: any) => o.ref).sort();
    check(oA.status === 200 && JSON.stringify(refsA) === JSON.stringify(dbA.slice(0, 200)), 'test4 sees exactly its ' + refsA.length + ' orders');
    check(!refsA.some((r: string) => dbDefault.has(r)) && oB.status === 200 && (oB.body?.orders || []).length === 0, 'no original-store order in either; store B has none (' + (oB.body?.orders || []).length + ')');

    console.log('\n/api/merchant/payments');
    const acctOf = async (t: string) => ((await db.select<any>('tenants', { where: { id: eq(t) }, select: ['stripe_account_id'] })) as any[])[0].stripe_account_id;
    const acctA = await acctOf(A);
    const pay = (token: string | null, body: any) => call('/api/merchant/payments', token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const badCountry = await pay(sB, { country: 'USA' });
    check(badCountry.status === 400, 'a malformed country is refused: ' + badCountry.status);
    check((await pay(sOwn, { country: 'US' })).status === 403, 'the original store\'s admin session cannot connect a merchant');
    const payA = await pay(sA, { country: 'US' });
    check(payA.status === 200 && payA.body?.status === 'ready' && !payA.body?.url, 'test4 (already connected) gets ready, no new account: ' + JSON.stringify(payA.body));
    const payB = await pay(sB, { country: 'US' });
    const acctB1 = await acctOf(B);
    check(payB.status === 200 && /^https:\/\/connect\.stripe\.com\//.test(String(payB.body?.url)) && /^acct_/.test(String(acctB1)), 'store B gets a Stripe onboarding link and ITS OWN account: ' + acctB1 + ' ' + JSON.stringify(payB.body).slice(0, 80));
    const payB2 = await pay(sB, { country: 'US' });
    check(payB2.status === 200 && (await acctOf(B)) === acctB1, 'a second click reuses the same account');
    const acctAAfter = await acctOf(A);
    check(acctAAfter === acctA && acctB1 !== acctA, 'test4\'s account is untouched and different from store B\'s');

    console.log('\n/api/merchant/settings and the store\'s own policy pages');
    // VISIBLE text only: the embedded page data (RSC) streams in a varying order
    // between identical requests, so raw HTML differs even when nothing changed.
    const pageText = async (url: string) => { const r = await fetch(url); return { status: r.status, text: (await r.text()).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ') }; };
    const shopTermsBefore = await pageText('https://shop.goyunir.com/terms');
    const defaultRowBefore = JSON.stringify((await db.select<any>('tenant_store_config', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['config'] })) as any[]);
    const markA = 'TEST4-TERMS-' + run, markB = 'STOREB-TERMS-' + run;
    const setA = await call('/api/merchant/settings', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brandName: 'test4', legal: { companyName: 'Test Four Co', supportEmail: 'help@test4.example', terms: 'Terms heading\n' + markA, privacy: '', shipping: '' } }) });
    const setB = await call('/api/merchant/settings', sB, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brandName: 'goyunir test 1', tenantId: A, legal: { companyName: 'Store B Co', terms: markB } }) });
    check(setA.status === 200 && setB.status === 200, 'both owners save their own settings: ' + setA.status + ' / ' + setB.status);
    const getA = await call('/api/merchant/settings', sA);
    const getB = await call('/api/merchant/settings', sB);
    check(String(getA.body?.legal?.terms).includes(markA) && !String(getA.body?.legal?.terms).includes(markB), 'test4 reads back only its own terms');
    check(String(getB.body?.legal?.terms).includes(markB) && !String(getB.body?.legal?.terms).includes(markA), 'store B reads back only its own (the smuggled tenant id was ignored)');
    const defaultRowAfter = JSON.stringify((await db.select<any>('tenant_store_config', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['config'] })) as any[]);
    check(defaultRowAfter === defaultRowBefore, 'the original store\'s config row is byte-identical');
    const t4Terms = await pageText('https://test4.goyunir.com/terms');
    const bTerms = await pageText('https://goyunir-test-1.goyunir.com/terms');
    const t4Privacy = await pageText('https://test4.goyunir.com/privacy');
    check(t4Terms.status === 200 && t4Terms.text.includes(markA) && !t4Terms.text.includes(markB), 'test4.goyunir.com/terms shows test4\'s own terms only');
    check(bTerms.status === 200 && bTerms.text.includes(markB) && !bTerms.text.includes(markA), 'store B\'s /terms shows store B\'s own terms only');
    check(t4Privacy.status === 200 && /has not published its privacy policy yet/.test(t4Privacy.text) && t4Privacy.text.includes('help@test4.example'), 'an unset policy says it is not published (with the store\'s own contact), no template text');
    const shopTermsAfter = await pageText('https://shop.goyunir.com/terms');
    const strip = (t: string) => t.replace(/Last updated: \d{4}-\d{2}-\d{2}/, '').replace(/\s+/g, ' ');
    check(shopTermsAfter.status === 200 && strip(shopTermsAfter.text) === strip(shopTermsBefore.text) && !shopTermsAfter.text.includes(markA) && !shopTermsAfter.text.includes(markB), 'the original store\'s /terms is unchanged (identical text before and after)');
    check((await pageText('https://nosuchstore-xyz.goyunir.com/terms')).status === 404, 'an unknown address still gets 404 for /terms');

    console.log('\nFences');
    check((await call('/api/merchant/store', sA, {}, 'https://shop.goyunir.com')).status === 404, 'the merchant API does not answer on the original store\'s host');
    check((await call('/api/merchant/store', sA, {}, 'https://test4.goyunir.com')).status === 404, 'nor on a merchant\'s storefront address');
    const csrf = await post(sB, { name: 'CSRF', sizes: [{ size: 'M', price: 5 }] }, { origin: 'https://evil.example' });
    check(csrf.status === 403, 'a cross-site write is blocked: ' + csrf.status);
    check((await call('/api/admin/products?includeArchived=true', sA)).status === 403, 'the admin tree still refuses a merchant session');

    console.log('\nRevocation');
    await db.update('users', { where: { email: eq(B_OWNER) } }, { tenant_id: A }, { returning: 'minimal' } as any);
    const moved = await call('/api/merchant/store', sB);
    check(moved.status === 403 && moved.body?.code === 'MEMBERSHIP_REVOKED', 'store B owner moved away in the database: the old session stops at once (' + moved.status + ' ' + moved.body?.code + ')');
    await db.update('users', { where: { email: eq(B_OWNER) } }, { tenant_id: B }, { returning: 'minimal' } as any);
    check((await call('/api/merchant/store', sB)).status === 200, 'restored: the session works again');
  } finally {
    for (const t of [sA, sB, sOwn]) await kv.hdel(ADMIN_DEVICES_KEY, t);
    console.log('\nsessions deleted');
  }
  void defaultNames;
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.message || e); process.exit(1); });
