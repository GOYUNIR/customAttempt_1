/**
 * ORIGINAL STORE ADMIN STOCK TOOL PROOF (/api/admin/stock, lib/admin-stock.ts),
 * on production (admin.<root>), on the hidden fixture so no real product moves.
 *
 *   npx tsx scripts/verify-admin-stock.ts
 *
 *   1. the original store's admin can count, add and remove stock (never below
 *      zero; a blank count is not zero);
 *   2. a merchant's session is refused (403) and changes nothing; a sales-role
 *      session is refused too;
 *   3. every change is recorded: the stock history (by whom) and the original
 *      store's audit;
 *   plus: the admin cannot touch another store's size; every real product's
 *   stock row is byte-identical; the Stock tab works in a real browser.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const ADMIN = 'https://admin.goyunir.com';
const APP = 'https://app.goyunir.com';
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4 (a merchant)
const ADMIN_EMAIL = 'stock-proof-admin@goyunir.invalid';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { resolveVariantId } = await import('../lib/inventory');
  const { ensureDefaultTenant } = await import('../lib/tenant-context');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { ADMIN_DEVICES_KEY } = await import('../lib/redis-keys');
  const stock = await import('../lib/stock');
  const db = getDb();
  const kv: any = createKvClient();
  const T = await ensureDefaultTenant();
  const run = Date.now().toString(36);
  const fix = String(await resolveVariantId(T, 'prod_stock_orig_fixture', 'One'));
  const test4Variant = String(await resolveVariantId(A, 'prod_tenant_test_1', 'One Size'));
  if (fix === 'null') throw new Error('run scripts/verify-stock-original.ts once first (it creates the fixture)');
  const others = async () => JSON.stringify(((await db.select<any>('inventory_levels', { where: { tenant_id: eq(T) }, select: ['variant_id', 'quantity_available'], order: { column: 'variant_id', ascending: true } })) as any[]).filter((r) => r.variant_id !== fix));
  const realBefore = await others();
  const test4Before = (await stock.stockLevels(A, [test4Variant])).get(test4Variant)!.onHand;
  const onHand = async () => (await stock.stockLevels(T, [fix])).get(fix)!.onHand;

  // Sessions exactly as the sign-ins issue them.
  const sAdmin = (await issueAdminDevice(kv, ADMIN_EMAIL, false, { role: 'owner' }, 600)).token; // the original store's owner/admin
  const merchantOwner = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sMerchant = (await issueAdminDevice(kv, merchantOwner, false, deviceMetaFor((await readStaffIdentity(merchantOwner))!), 600)).token;
  const sSales = (await issueAdminDevice(kv, 'stock-proof-sales@goyunir.invalid', false, { role: 'sales' }, 600)).token;
  const sSuper = (await issueAdminDevice(kv, 'stock-proof-super@goyunir.invalid', false, { superAdmin: true }, 600)).token;
  const call = async (base: string, path: string, token: string, body?: any) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { cookie: 'goyunir_admin_device=' + token, ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let b: any = null; try { b = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: b };
  };

  try {
    await stock.setStock(T, fix, 0, 'verify-admin-stock', run + ' setup');

    console.log('\n1. The original store\'s admin can change stock');
    const ov = await call(ADMIN, '/api/admin/stock', sAdmin);
    const ids = (ov.body?.products || []).flatMap((p: any) => p.sizes.map((s: any) => s.variantId)).filter(Boolean);
    const defaultIds = new Set(((await db.select<any>('product_variants', { where: { tenant_id: eq(T) }, select: ['id'] })) as any[]).map((v) => String(v.id)));
    check(ov.status === 200 && ids.includes(fix) && ids.every((x: string) => defaultIds.has(x)), 'the Stock overview lists only the original store\'s sizes (' + ids.length + ')');
    const set = await call(ADMIN, '/api/admin/stock/set', sAdmin, { variantId: fix, count: 7, note: 'admin proof count ' + run, tenantId: A });
    check(set.status === 200 && set.body?.onHand === 7 && (await onHand()) === 7, 'count 7: saved (a smuggled store id is ignored): ' + set.status);
    const rem = await call(ADMIN, '/api/admin/stock/adjust', sAdmin, { variantId: fix, delta: -2, reason: 'adjust', note: 'admin proof damaged ' + run });
    const add = await call(ADMIN, '/api/admin/stock/adjust', sAdmin, { variantId: fix, delta: 3, note: 'admin proof restock ' + run });
    check(rem.status === 200 && add.status === 200 && (await onHand()) === 8, 'remove 2, add 3: 7 -> 5 -> 8');
    const low = await call(ADMIN, '/api/admin/stock/adjust', sAdmin, { variantId: fix, delta: -99, reason: 'adjust' });
    const blank = await call(ADMIN, '/api/admin/stock/set', sAdmin, { variantId: fix, count: '' });
    check(low.status === 409 && blank.status === 400 && (await onHand()) === 8, 'never below zero (409); a blank count is refused, not zero (400)');

    console.log('\n2. A merchant\'s session (and a sales role) is refused');
    const mGet = await call(ADMIN, '/api/admin/stock', sMerchant);
    const mSet = await call(ADMIN, '/api/admin/stock/set', sMerchant, { variantId: fix, count: 999 });
    const mAdj = await call(ADMIN, '/api/admin/stock/adjust', sMerchant, { variantId: fix, delta: 999 });
    check(mGet.status === 403 && mSet.status === 403 && mAdj.status === 403 && (await onHand()) === 8, 'test4\'s owner session: 403 on read, count and adjust; the fixture is still 8 (' + [mGet.status, mSet.status, mAdj.status].join('/') + ')');
    const mApp = await call(APP, '/api/admin/stock/set', sMerchant, { variantId: fix, count: 999 });
    check(mApp.status !== 200 && (await onHand()) === 8, 'and from the merchant portal host too: ' + mApp.status);
    const sGet = await call(ADMIN, '/api/admin/stock', sSales);
    const sSet = await call(ADMIN, '/api/admin/stock/set', sSales, { variantId: fix, count: 999 });
    check(sGet.status === 403 && sSet.status === 403 && (await onHand()) === 8, 'a sales-role session: 403 (' + sGet.status + '/' + sSet.status + ')');
    const foreign = await call(ADMIN, '/api/admin/stock/set', sAdmin, { variantId: test4Variant, count: 999 });
    const test4After = (await stock.stockLevels(A, [test4Variant])).get(test4Variant)!.onHand;
    check(foreign.status === 404 && test4After === test4Before, 'the admin cannot count another store\'s size: ' + foreign.status + ', test4 still ' + test4After);

    console.log('\n3. Every change is recorded');
    const hist = await call(ADMIN, '/api/admin/stock/history?variantId=' + fix, sAdmin);
    const mine = (hist.body?.history || []).filter((m: any) => String(m.note || '').includes(run));
    check(hist.status === 200 && mine.length === 3 && mine.every((m: any) => m.by === ADMIN_EMAIL) && JSON.stringify(mine.map((m: any) => [m.reason, m.change, m.after])) === JSON.stringify([['restock', 3, 8], ['adjust', -2, 5], ['count', 7, 7]]), 'the history holds all three changes, by the admin, with the level after each: ' + JSON.stringify(mine.map((m: any) => [m.reason, m.change, m.after])));
    // From this run's own first entry: the fixture's older history has one
    // known gap from before 2026-09-27 07:00 UTC (a sale by the pre-ledger
    // webhook code while the step-5 deploy was rolling out).
    const all = (await db.select<any>('stock_movements', { where: { tenant_id: eq(T), variant_id: eq(fix) }, select: ['delta', 'quantity_after', 'note'], order: { column: 'id', ascending: true } })) as any[];
    // (The setup count may be a no-op and write nothing, so start from this
    // run's first REAL change: the count of 7. A missing start fails.)
    const start = all.findIndex((m) => String(m.note || '').includes(run));
    const moves = start >= 0 ? all.slice(start) : [];
    let chain = moves.length >= 3; for (let i = 1; i < moves.length; i++) if (moves[i].quantity_after !== moves[i - 1].quantity_after + moves[i].delta) chain = false;
    check(chain && moves[moves.length - 1].quantity_after === (await onHand()), 'this run\'s history is an unbroken chain ending at on hand (' + moves.length + ' movements)');
    const audit = ((await kv.lrange('admin:audit_log', -50, -1)) || []).map((r: any) => (typeof r === 'string' ? r : JSON.stringify(r))).filter((r: string) => r.includes(run));
    const auditRows = (await db.select<any>('audit_logs', { where: { actor: eq(ADMIN_EMAIL) }, select: ['action', 'tenant_id', 'created_at'], order: { column: 'created_at', ascending: false }, limit: 5 })) as any[];
    check(audit.length === 3 && audit.every((r: string) => r.includes(ADMIN_EMAIL)) && auditRows.slice(0, 3).every((r) => r.tenant_id === T && /^STOCK_(COUNTED|ADJUSTED)$/.test(r.action)), 'each change is in the original store\'s audit (its admin list and the platform table): ' + audit.length);

    console.log('\nThe real products, and the Stock tab in a browser');
    check((await others()) === realBefore, 'every real product\'s stock row is byte-identical');
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      // The admin PAGE on admin.<root> is super-admin only (the owner's real
      // session is one); the stock API itself accepts owner/staff too.
      await ctx.addCookies([{ name: 'goyunir_admin_device', value: sSuper, domain: 'admin.goyunir.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      await page.goto(ADMIN + '/admin', { waitUntil: 'load', timeout: 60_000 }); await page.waitForTimeout(5000);
      await page.locator('button', { hasText: /^\W*Stock\b/ }).first().click({ timeout: 15_000 }); await page.waitForTimeout(3000);
      const label = 'Counted units for Stock proof fixture One';
      await page.getByLabel(label).fill('4');
      const row = page.getByLabel(label).locator('xpath=ancestor::div[2]');
      await row.getByRole('button', { name: 'Set count' }).click(); await page.waitForTimeout(3000);
      const text = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(process.cwd(), 'tenant-checkout-out', 'admin-stock.png'), fullPage: false });
      check(/Count saved: 4 on hand/.test(text) && (await onHand()) === 4, 'admin -> Stock: counting 4 in the form saves it (' + (await onHand()) + ' on hand)');
    } finally { await browser.close(); }
  } finally {
    await stock.setStock(T, fix, 0, 'verify-admin-stock', run + ' cleanup').catch(() => null);
    for (const t of [sAdmin, sMerchant, sSales, sSuper]) await kv.hdel(ADMIN_DEVICES_KEY, t);
    console.log('\nfixture back to 0, sessions deleted');
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.message || e); process.exit(1); });
