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
const SALES = 'https://sales.goyunir.com';
const RAFFLE_VARIANT_A = '1e02eebc-af34-4f52-b57d-5227b6633589'; // test4's raffle size (already drawn)
// Resend's official test inbox: accepts mail without delivering it anywhere.
const INVITE_PROBE = 'delivered@resend.dev';
let entryEmail = '';
let staffEmail = '';
let salesEmail = '';
const runStart = new Date().toISOString();
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq, isNull } = await import('../lib/db/query');
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
    const newVariant = newId ? await (await import('../lib/inventory')).resolveVariantId(B, newId, 'M') : null;
    const firstMove = newVariant ? ((await db.select<any>('stock_movements', { where: { variant_id: eq(newVariant) }, select: ['tenant_id', 'reason', 'delta', 'quantity_after', 'actor'] })) as any[]) : [];
    check(firstMove.length === 1 && firstMove[0].tenant_id === B && firstMove[0].reason === 'count' && firstMove[0].quantity_after === 4, 'its starting stock (4) is the first entry in its stock history, in store B: ' + JSON.stringify(firstMove));
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

    // ── Raffles & waitlists ────────────────────────────────────────────────
    console.log('\n/api/merchant/drops');
    const variantsOf = async (t: string) => new Set(((await db.select<any>('product_variants', { where: { tenant_id: eq(t) }, select: ['id'] })) as any[]).map((v) => String(v.id)));
    const aVariants = await variantsOf(A);
    const dA = await call('/api/merchant/drops', sA);
    const dB = await call('/api/merchant/drops', sB);
    const dAIds = (dA.body?.drops || []).map((d: any) => d.variantId);
    check(dA.status === 200 && dAIds.length > 0 && dAIds.every((v: string) => aVariants.has(v)) && dAIds.includes(RAFFLE_VARIANT_A), 'test4 lists only its own raffles/waitlists (' + dAIds.length + ')');
    check(dB.status === 200 && !(dB.body?.drops || []).some((d: any) => aVariants.has(d.variantId)), 'store B lists none of test4\'s (' + (dB.body?.drops || []).length + ')');
    entryEmail = 'iso-entry-' + Date.now() + '@goyunir.invalid';
    const inserted = (await db.insert<any>('raffle_entries', { tenant_id: A, variant_id: RAFFLE_VARIANT_A, email: entryEmail, status: 'pending', entry_type: 'raffle' })) as any[];
    const entryId = String(inserted[0].id);
    const eA = await call('/api/merchant/drops/entries?variantId=' + RAFFLE_VARIANT_A, sA);
    const eB = await call('/api/merchant/drops/entries?variantId=' + RAFFLE_VARIANT_A, sB);
    check(eA.status === 200 && (eA.body?.entries || []).some((e: any) => e.id === entryId) && !JSON.stringify(eA.body).match(/pm_|cus_|seti_/), 'test4 sees the entry (and no card/customer ids)');
    check(eB.status === 200 && (eB.body?.entries || []).length === 0, 'store B asking for test4\'s item by id gets nothing (' + (eB.body?.entries || []).length + ')');
    const stillPending = async () => String(((await db.select<any>('raffle_entries', { where: { id: eq(entryId) }, select: ['status'] })) as any[])[0]?.status);
    const cB = await call('/api/merchant/drops/cancel', sB, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryId, tenantId: A }) });
    check(cB.status === 404 && (await stillPending()) === 'pending', 'store B cannot remove test4\'s entry by id: ' + cB.status + ', entry still pending');
    const snapA = async () => JSON.stringify([
      ((await db.select<any>('raffle_entries', { where: { tenant_id: eq(A) }, select: ['id', 'status'], order: { column: 'id', ascending: true } })) as any[]),
      ((await db.select<any>('drop_draws', { where: { tenant_id: eq(A) }, select: ['id'] })) as any[]).length,
    ]);
    const beforeRun = await snapA();
    const runB = await call('/api/merchant/drops/run', sB, { method: 'POST' });
    check(runB.status === 200 && (await snapA()) === beforeRun, 'store B running its draws leaves every test4 entry and draw untouched: ' + JSON.stringify(runB.body));
    const cA = await call('/api/merchant/drops/cancel', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryId }) });
    check(cA.status === 200 && (await stillPending()) === 'cancelled', 'test4 removes its own pending entry');
    const cA2 = await call('/api/merchant/drops/cancel', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entryId }) });
    check(cA2.status === 404, 'an entry no longer pending cannot be removed again');

    // ── Stock tools (00037) ────────────────────────────────────────────────
    console.log('\n/api/merchant/stock');
    const { resolveVariantId } = await import('../lib/inventory');
    const fixture = String(await resolveVariantId(A, 'prod_stock_race', 'One'));
    const defaultStockBefore = JSON.stringify(await db.select<any>('inventory_levels', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['variant_id', 'quantity_available'], order: { column: 'variant_id', ascending: true } }));
    const skA = await call('/api/merchant/stock', sA);
    const skB = await call('/api/merchant/stock', sB);
    const idsOf = (b: any) => (b?.products || []).flatMap((p: any) => p.sizes.map((z: any) => z.variantId)).filter(Boolean);
    check(skA.status === 200 && idsOf(skA.body).length > 0 && idsOf(skA.body).every((x: string) => aVariants.has(x)) && idsOf(skA.body).includes(fixture), 'test4 lists only its own sizes (' + idsOf(skA.body).length + ')');
    check(skB.status === 200 && !idsOf(skB.body).some((x: string) => aVariants.has(x)), 'store B lists none of test4\'s sizes');
    const stPost = (tok: string, path: string, b: any) => call('/api/merchant/stock/' + path, tok, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const onHandNow = async () => Number(((await db.select<any>('inventory_levels', { where: { variant_id: eq(fixture) }, select: ['quantity_available'] })) as any[])[0]?.quantity_available);
    const stockSetA = await stPost(sA, 'set', { variantId: fixture, count: 7, note: 'iso count', tenantId: B, tenant_id: B });
    check(stockSetA.status === 200 && stockSetA.body?.onHand === 7 && (await onHandNow()) === 7, 'test4 counts its own size to 7 (a smuggled store id is ignored): ' + stockSetA.status);
    const bSetStock = await stPost(sB, 'set', { variantId: fixture, count: 999 });
    const bAdj = await stPost(sB, 'adjust', { variantId: fixture, delta: 999 });
    check(bSetStock.status === 404 && bAdj.status === 404 && (await onHandNow()) === 7, 'store B cannot count or restock test4\'s size by id: ' + bSetStock.status + '/' + bAdj.status + ', still 7');
    const adjA = await stPost(sA, 'adjust', { variantId: fixture, delta: -3, reason: 'adjust', note: 'iso damaged' });
    const tooLow = await stPost(sA, 'adjust', { variantId: fixture, delta: -10, reason: 'adjust' });
    const blank = await stPost(sA, 'set', { variantId: fixture, count: '' });
    check(adjA.status === 200 && adjA.body?.onHand === 4 && tooLow.status === 409 && blank.status === 400 && (await onHandNow()) === 4, 'remove 3 -> 4; never below zero (409); a blank count is refused, not zero (400)');
    const hA = await call('/api/merchant/stock/history?variantId=' + fixture, sA);
    const hB = await call('/api/merchant/stock/history?variantId=' + fixture, sB);
    const top2 = (hA.body?.history || []).slice(0, 2);
    check(hA.status === 200 && top2[0]?.change === -3 && top2[0]?.by === aOwner && top2[1]?.reason === 'count' && top2[1]?.after === 7, 'history shows the count and the removal, by the owner: ' + JSON.stringify(top2.map((m: any) => [m.reason, m.change, m.after, m.by])));
    check(hB.status === 200 && (hB.body?.history || []).length === 0, 'store B asking for test4\'s history gets nothing');
    const stockAudit = ((await db.select<any>('audit_logs', { where: { action: eq('MERCHANT_STOCK_ADJUSTED'), actor: eq(aOwner) }, select: ['tenant_id'], order: { column: 'created_at', ascending: false }, limit: 1 })) as any[])[0];
    check(stockAudit?.tenant_id === A, 'stock changes are audited, tagged test4');
    check(JSON.stringify(await db.select<any>('inventory_levels', { where: { tenant_id: eq(DEFAULT_TENANT_ID) }, select: ['variant_id', 'quantity_available'], order: { column: 'variant_id', ascending: true } })) === defaultStockBefore, 'the original store\'s stock rows are byte-identical');

    // ── Audit placement ────────────────────────────────────────────────────
    console.log('\nAudit');
    const auditRows = async (action: string, actor: string) => (await db.select<any>('audit_logs', { where: { action: eq(action), actor: eq(actor) }, select: ['tenant_id', 'detail', 'created_at'], order: { column: 'created_at', ascending: false }, limit: 5 })) as any[];
    const cancelAudit = (await auditRows('MERCHANT_ENTRY_CANCELLED', aOwner))[0];
    check(cancelAudit?.tenant_id === A && String(cancelAudit?.detail?.detail) === entryEmail, 'the removal is in the platform audit, tagged test4: ' + JSON.stringify(cancelAudit));
    const settingsAuditB = (await auditRows('MERCHANT_SETTINGS_SAVED', B_OWNER))[0];
    check(settingsAuditB?.tenant_id === B, 'store B\'s settings save is tagged store B');
    // (the original store's admin audit list is checked at the end, over everything this run did)

    // ── Sign-out ───────────────────────────────────────────────────────────
    console.log('\n/api/merchant/signout');
    const sA2 = (await issueAdminDevice(kv, aOwner, false, deviceMetaFor(idA), 600)).token;
    const outRes = await fetch(APP + '/api/merchant/signout', { method: 'POST', headers: { cookie: 'goyunir_admin_device=' + sA2, origin: APP } });
    check(outRes.status === 200 && /goyunir_admin_device=;|Max-Age=0/i.test(String(outRes.headers.get('set-cookie'))), 'sign-out answers 200 and clears the cookie');
    check((await call('/api/merchant/store', sA2)).status === 401, 'the signed-out session no longer works (the record is gone, not just the cookie)');
    check((await call('/api/merchant/store', sA)).status === 200, 'the same owner\'s other session is unaffected');
    check((await call('/api/merchant/signout', null, { method: 'POST' })).status === 401, 'sign-out without a session: 401');

    // ── Staff ──────────────────────────────────────────────────────────────
    console.log('\n/api/merchant/staff');
    const tenantOfEmail = async (e: string) => ((await db.select<any>('users', { where: { email: eq(e) }, select: ['tenant_id', 'role'] })) as any[])[0];
    const sfA = await call('/api/merchant/staff', sA);
    const sfB = await call('/api/merchant/staff', sB);
    const aPeople = (sfA.body?.people || []).map((p: any) => p.email);
    const aTenants = await Promise.all(aPeople.map(tenantOfEmail));
    check(sfA.status === 200 && aPeople.includes(aOwner) && aTenants.every((u: any) => u?.tenant_id === A), 'test4 lists only test4\'s people: ' + aPeople.join(', '));
    check(sfB.status === 200 && !(sfB.body?.people || []).some((p: any) => aPeople.includes(p.email)), 'store B lists none of them');
    await db.update('staff_invites', { where: { email: eq(INVITE_PROBE), accepted_at: isNull() } }, { revoked_at: new Date().toISOString() }, { returning: 'minimal' } as any).catch(() => null);
    const inv = await call('/api/merchant/staff/invite', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: INVITE_PROBE, role: 'owner', tenantId: B, tenant_id: B }) });
    const invRow = ((await db.select<any>('staff_invites', { where: { email: eq(INVITE_PROBE) }, select: ['id', 'tenant_id', 'role', 'revoked_at', 'accepted_at'], order: { column: 'created_at', ascending: false }, limit: 1 })) as any[])[0];
    check(inv.status === 201 && invRow?.tenant_id === A && invRow?.role === 'staff', 'an owner\'s invite is for THEIR store as staff (smuggled role/store ignored): ' + inv.status + ' ' + JSON.stringify(invRow));
    const invIdsB = (sfB.body?.invites || []).map((i: any) => i.id);
    check(!invIdsB.includes(invRow?.id) && !((await call('/api/merchant/staff', sB)).body?.invites || []).some((i: any) => i.id === invRow?.id), 'store B does not see test4\'s invite');
    const rvB = await call('/api/merchant/staff/revoke-invite', sB, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteId: invRow?.id }) });
    const invAfterB = ((await db.select<any>('staff_invites', { where: { id: eq(invRow?.id) }, select: ['revoked_at'] })) as any[])[0];
    check(rvB.status === 404 && !invAfterB?.revoked_at, 'store B cannot revoke test4\'s invite: ' + rvB.status);
    const rvA = await call('/api/merchant/staff/revoke-invite', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteId: invRow?.id }) });
    const invAfterA = ((await db.select<any>('staff_invites', { where: { id: eq(invRow?.id) }, select: ['revoked_at'] })) as any[])[0];
    check(rvA.status === 200 && Boolean(invAfterA?.revoked_at), 'test4 revokes its own invite');

    // A staff member of test4, made through the real invite + accept flow.
    staffEmail = 'iso-staff-a-' + Date.now() + '@goyunir.invalid';
    const sInv: any = await createInvite({ email: staffEmail, role: 'staff', tenantId: A, invitedByEmail: aOwner });
    const acc = await fetch(APP + '/api/admin/accept-invite', { method: 'POST', headers: { 'content-type': 'application/json', origin: APP }, body: JSON.stringify({ token: sInv.token, password: 'Iso-' + crypto.randomUUID() + '-Aa1!' }) });
    const idS = await readStaffIdentity(staffEmail);
    check(acc.status === 200 && idS?.tenantId === A && idS?.role === 'staff', 'test4 staff member created through the real accept route: ' + acc.status);
    const sS = (await issueAdminDevice(kv, staffEmail, false, deviceMetaFor(idS!), 600)).token;
    const sStore = await call('/api/merchant/store', sS);
    check(sStore.status === 200 && sStore.body?.store?.slug === 'test4' && sStore.body?.you?.role === 'staff', 'the staff session runs test4');
    check((await call('/api/merchant/products', sS)).status === 200 && (await call('/api/merchant/drops', sS)).status === 200, 'staff can use products and raffles');
    const staffRefusals = [
      (await call('/api/merchant/staff', sS)).status,
      (await call('/api/merchant/staff/invite', sS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@goyunir.invalid' }) })).status,
      (await call('/api/merchant/staff/remove', sS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: aOwner }) })).status,
      (await call('/api/merchant/payments', sS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ country: 'US' }) })).status,
      (await call('/api/merchant/billing', sS)).status,
      (await call('/api/merchant/billing/checkout', sS, { method: 'POST' })).status,
      (await call('/api/merchant/billing/portal', sS, { method: 'POST' })).status,
    ];
    check(staffRefusals.every((s) => s === 403), 'staff cannot see or change staff, or touch payments or billing: ' + staffRefusals.join(','));
    const rmB = await call('/api/merchant/staff/remove', sB, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: staffEmail }) });
    check(rmB.status === 404 && (await tenantOfEmail(staffEmail))?.tenant_id === A, 'store B cannot remove test4\'s staff: ' + rmB.status);
    check((await call('/api/merchant/staff/remove', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: B_OWNER }) })).status === 404 && (await tenantOfEmail(B_OWNER))?.tenant_id === B, 'test4 cannot remove store B\'s owner');
    check((await call('/api/merchant/staff/remove', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: aOwner }) })).status === 400, 'an owner cannot remove themselves');
    const rmA = await call('/api/merchant/staff/remove', sA, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: staffEmail }) });
    const afterRm = await call('/api/merchant/store', sS);
    check(rmA.status === 200 && afterRm.status === 403 && afterRm.body?.code === 'MEMBERSHIP_REVOKED', 'removed: their open session stops at once (' + afterRm.status + ' ' + afterRm.body?.code + ')');
    check(!(await tenantOfEmail(staffEmail)) && !(await readStaffIdentity(staffEmail)), 'and the account is gone: no staff identity anywhere, so not the original store\'s either');
    const adminAsRemoved = await call('/api/admin/products?includeArchived=true', sS);
    check(adminAsRemoved.status === 401 || adminAsRemoved.status === 403, 'the removed person gets nothing from the admin tree: ' + adminAsRemoved.status);
    staffEmail = '';

    // ── Platform support (sales), through the real impersonation route ─────
    console.log('\nSupport sessions');
    salesEmail = 'iso-sales-' + Date.now() + '@goyunir.invalid';
    const salesPassword = 'Iso-' + crypto.randomUUID() + '-Aa1!';
    const salesInv: any = await createInvite({ email: salesEmail, role: 'sales', tenantId: null, invitedByEmail: 'isolation-proof@goyunir.invalid' });
    const salesAcc = await fetch(SALES + '/api/admin/accept-invite', { method: 'POST', headers: { 'content-type': 'application/json', origin: SALES }, body: JSON.stringify({ token: salesInv.token, password: salesPassword }) });
    const idSales = await readStaffIdentity(salesEmail);
    check(salesAcc.status === 200 && idSales?.role === 'sales', 'a sales account created through the real accept route: ' + salesAcc.status);
    await db.insert('sales_tenant_assignments', { sales_user_id: idSales!.id, tenant_id: A }, { returning: 'minimal' } as any);
    const impersonate = (tenant: string) => fetch(SALES + '/api/admin/impersonate', { method: 'POST', headers: { 'content-type': 'application/json', origin: SALES, 'x-staff-impersonate-tenant-id': tenant }, body: JSON.stringify({ email: salesEmail, password: salesPassword }) });
    const imp = await impersonate(A);
    const impBody: any = await imp.json().catch(() => ({}));
    const code = String(impBody?.next || '').split('#')[1] || '';
    check(imp.status === 200 && String(impBody?.next).startsWith(APP + '/app/support#') && /^[0-9a-f]{64}$/.test(code) && !imp.headers.get('set-cookie'), 'impersonating test4 returns a one-time link to the dashboard host (fragment), and no cookie: ' + imp.status);
    const impB = await impersonate(B);
    check(impB.status === 401, 'impersonating store B (not assigned) is refused: ' + impB.status);
    const redeem = (base: string) => fetch(base + '/api/merchant-support/redeem', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ code }) });
    check((await redeem(SALES)).status === 404, 'the code cannot be redeemed on the sales host');
    const red = await redeem(APP);
    const sSup = (String(red.headers.get('set-cookie') || '').match(/goyunir_admin_device=([^;]+)/) || [])[1] || '';
    check(red.status === 200 && sSup.length > 20, 'redeemed on the dashboard host: 200 with a session cookie');
    check((await redeem(APP)).status === 401, 'the same code a second time: 401');
    const supStore = await call('/api/merchant/store', sSup);
    check(supStore.status === 200 && supStore.body?.store?.slug === 'test4' && supStore.body?.you?.role === 'support', 'the support session runs test4, as support: ' + JSON.stringify(supStore.body?.you));
    const supRefusals = [
      (await call('/api/merchant/staff', sSup)).status,
      (await call('/api/merchant/payments', sSup, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ country: 'US' }) })).status,
      (await call('/api/merchant/billing', sSup)).status,
      (await call('/api/merchant/billing/checkout', sSup, { method: 'POST' })).status,
      (await call('/api/merchant/billing/portal', sSup, { method: 'POST' })).status,
    ];
    check(supRefusals.every((s) => s === 403), 'support cannot touch staff, payments or billing: ' + supRefusals.join(','));
    const cur = await call('/api/merchant/settings', sSup);
    const supSave = await call('/api/merchant/settings', sSup, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cur.body) });
    const supAudit = (await auditRows('MERCHANT_SETTINGS_SAVED', salesEmail))[0];
    check(supSave.status === 200 && supAudit?.tenant_id === A && supAudit?.detail?.support === true, 'a support write is audited under the support person, tagged test4, marked support: ' + JSON.stringify(supAudit?.detail));
    const fixtureId = String(await (await import('../lib/inventory')).resolveVariantId(A, 'prod_stock_race', 'One'));
    const supCount = await call('/api/merchant/stock/set', sSup, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variantId: fixtureId, count: 0, note: 'iso support count' }) });
    const supStockAudit = (await auditRows('MERCHANT_STOCK_COUNTED', salesEmail))[0];
    check(supCount.status === 200 && supStockAudit?.tenant_id === A && supStockAudit?.detail?.support === true, 'support can count stock, audited as support, tagged test4 (fixture back to 0)');
    const forgedB = (await issueAdminDevice(kv, salesEmail, false, { role: 'sales', impersonating: true, tenantId: B }, 600)).token;
    const fB = await call('/api/merchant/store', forgedB);
    check(fB.status === 403 && fB.body?.code === 'ASSIGNMENT_REVOKED', 'a support session forged for store B is refused: ' + fB.status + ' ' + fB.body?.code);
    await kv.hdel(ADMIN_DEVICES_KEY, forgedB);
    await db.remove('sales_tenant_assignments', { where: { sales_user_id: eq(idSales!.id), tenant_id: eq(A) } });
    const unassigned = await call('/api/merchant/store', sSup);
    check(unassigned.status === 403 && unassigned.body?.code === 'ASSIGNMENT_REVOKED', 'assignment removed: the open support session stops at once (' + unassigned.status + ' ' + unassigned.body?.code + ')');
    await kv.hdel(ADMIN_DEVICES_KEY, sSup);

    console.log('\nThe original store\'s admin audit list');
    // Everything written there during THIS run (invites accepted, support
    // entering a store, merchant writes) must not mention a merchant store.
    const kvAudit = ((await kv.lrange('admin:audit_log', -200, -1)) || [])
      .map((r: any) => (typeof r === 'string' ? r : JSON.stringify(r)))
      .filter((r: string) => { try { return String(JSON.parse(r).at) >= runStart; } catch { return false; } });
    // A PLATFORM sales account joining is a platform event (no store): it belongs
    // in the platform owner's view. Only store-specific markers count here.
    const leaked = kvAudit.filter((r: string) => /MERCHANT_|iso-entry|iso-staff-a|isolation-owner-b|delivered@resend|test4|goyunir test 1/i.test(r));
    check(leaked.length === 0, 'nothing about a merchant store reached it during this run (' + kvAudit.length + ' new entries, ' + leaked.length + ' about merchants)' + (leaked.length ? ': ' + leaked.join(' | ').slice(0, 300) : ''));

    console.log('\nRevocation');
    await db.update('users', { where: { email: eq(B_OWNER) } }, { tenant_id: A }, { returning: 'minimal' } as any);
    const moved = await call('/api/merchant/store', sB);
    check(moved.status === 403 && moved.body?.code === 'MEMBERSHIP_REVOKED', 'store B owner moved away in the database: the old session stops at once (' + moved.status + ' ' + moved.body?.code + ')');
    await db.update('users', { where: { email: eq(B_OWNER) } }, { tenant_id: B }, { returning: 'minimal' } as any);
    check((await call('/api/merchant/store', sB)).status === 200, 'restored: the session works again');
  } finally {
    // Throwaway people and rows from this run (store B's owner is kept for re-runs).
    const { deleteStaffAccount } = await import('../lib/staff-accounts');
    if (entryEmail) await db.remove('raffle_entries', { where: { tenant_id: eq(A), email: eq(entryEmail) } }).catch(() => null);
    for (const e of [staffEmail, salesEmail]) {
      if (!e || (await deleteStaffAccount(e).catch(() => false))) continue;
      // Referenced by the append-only audit log (until 00036): revoke instead.
      const u = ((await db.select<any>('users', { where: { email: eq(e) }, select: ['id'] })) as any[])[0];
      if (u) {
        await db.update('users', { where: { id: eq(u.id) } }, { role: 'customer', tenant_id: null }, { returning: 'minimal' } as any).catch(() => null);
        const sc: any = await import('../services/config/supabase-client');
        const loginGone = await sc.supabaseAuthFetch('/admin/users/' + u.id, { key: sc.readSupabaseEnv().serviceRoleKey, method: 'DELETE' }).then(() => true, () => false);
        console.log('cleanup: ' + e + ' is referenced by the append-only audit log (00036 not applied): role revoked' + (loginGone ? ', login deleted' : '; login kept (same reference) but it has no role'));
      }
    }
    for (const t of [sA, sB, sOwn]) await kv.hdel(ADMIN_DEVICES_KEY, t);
    console.log('\nsessions deleted');
  }
  void defaultNames;
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.message || e); process.exit(1); });
