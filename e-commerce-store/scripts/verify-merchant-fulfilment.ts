/**
 * FULFILMENT, live: order detail and "mark shipped" (v1, whole order), and
 * that no other store can see, ship or email about it.
 *
 *   npx tsx scripts/verify-tenant-checkout.ts      (makes a fresh paid test4 order)
 *   npx tsx scripts/verify-merchant-fulfilment.ts
 *
 * Ships the newest unshipped test4 order whose customer is on the SINK domain
 * (EMAIL_SINK_DOMAINS): the "shipped" email is recorded, never sent. It
 * refuses to touch an order with a real customer address.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const APP = 'https://app.goyunir.com';
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
const SINK = String(process.env.EMAIL_SINK_DOMAINS || '').split(',')[0].trim();
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);

(async () => {
  if (!SINK) throw new Error('EMAIL_SINK_DOMAINS is not set: refusing to run (the shipped email must not be real)');
  const { getDb } = await import('../lib/db/client');
  const { eq, gte } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { sentTo } = await import('./resend-readback');
  const kv: any = createKvClient();
  const db = getDb();
  const ownerA = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sA = (await issueAdminDevice(kv, ownerA, false, deviceMetaFor((await readStaffIdentity(ownerA))!), 900)).token;
  const sB = (await issueAdminDevice(kv, B_OWNER, false, deviceMetaFor((await readStaffIdentity(B_OWNER))!), 900)).token;
  const hdr = (tok: string | null, extra: Record<string, string> = {}) => ({ origin: APP, 'content-type': 'application/json', ...(tok ? { cookie: 'goyunir_admin_device=' + tok } : {}), ...extra });
  const call = async (path: string, tok: string | null, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const r = await fetch(APP + path, { method: init.method || 'GET', headers: hdr(tok, init.headers), ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    let body: any = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };
  const startedAt = new Date(Date.now() - 5000).toISOString();

  console.log('\nThe order to ship (test4, customer on the sink domain)');
  const list = (await call('/api/merchant/orders', sA)).body?.orders || [];
  const target = list.find((o: any) => o.stage === 'to_ship' && String(o.customerEmail || '').endsWith('@' + SINK));
  if (!target) throw new Error('no unshipped test4 order with a sink-domain customer: run scripts/verify-tenant-checkout.ts first');
  check(true, 'found ' + target.ref + ' (' + target.customerEmail + '), stage "' + target.stage + '"');
  const ref = target.ref;

  console.log('\nOrder detail');
  const d = (await call('/api/merchant/orders?ref=' + encodeURIComponent(ref), sA)).body?.order;
  check(Boolean(d) && d.customer.email === target.customerEmail && d.lines.length >= 1 && d.totals.totalCents > 0, 'customer, lines and total: ' + (d ? d.lines.map((l: any) => l.productName + ' ' + l.size).join(', ') + ', ' + d.totals.totalCents : 'none'));
  check(Boolean(d?.customer.shippingAddress), 'the shipping address the buyer entered: ' + String(d?.customer.shippingAddress || '(missing)').slice(0, 50));
  check(typeof d?.totals.platformFeeCents === 'number' && d.paymentStatus === 'paid', 'our fee (' + d?.totals.platformFeeCents + ') and payment status (' + d?.paymentStatus + ')');
  check(/^https:\/\/dashboard\.stripe\.com\/test\/payments\/pi_/.test(String(d?.stripePaymentUrl)), 'refunds: a link to this payment in the merchant\'s own Stripe (test mode): ' + d?.stripePaymentUrl);
  check(Array.isArray(d?.timeline) && d.timeline[0]?.what === 'Paid', 'timeline starts with the payment');

  console.log('\nAnother store cannot see, ship or email about it');
  check((await call('/api/merchant/orders?ref=' + encodeURIComponent(ref), sB)).status === 404, 'store B asking for test4\'s order by ref: 404');
  check(!((await call('/api/merchant/orders', sB)).body?.orders || []).some((o: any) => o.ref === ref), 'it is not in store B\'s list');
  const bShip = await call('/api/merchant/orders/ship', sB, { method: 'POST', body: { ref, carrier: 'ups', trackingNumber: 'EVIL' + run, tenantId: A, tenant_id: A } });
  check(bShip.status === 404, 'store B shipping it (with test4\'s id smuggled in): ' + bShip.status);
  check((await call('/api/merchant/orders/ship', sB, { method: 'POST', body: { ref, emailOnly: true } })).status === 404, 'store B triggering its "shipped" email: 404');
  check((await call('/api/merchant/orders/ship', null, { method: 'POST', body: { ref, carrier: 'ups', trackingNumber: 'X' + run } })).status === 401, 'no session: 401');
  check((await call('/api/merchant/orders/ship', sA, { method: 'POST', body: { ref, carrier: 'ups', trackingNumber: 'X' + run }, headers: { origin: 'https://evil.example' } })).status === 403, 'a cross-site write with test4\'s own cookie: 403');
  check((await call('/api/merchant/orders?ref=' + encodeURIComponent("x' or '1'='1"), sA)).status === 404, 'a malformed ref: 404');
  const orderRow = ((await db.select<any>('orders', { where: { tenant_id: eq(A), order_ref: eq(ref) }, select: ['id', 'status'], limit: 1 })) as any[])[0];
  check(((await db.select<any>('order_fulfilments', { where: { order_id: eq(orderRow.id) } })) as any[]).length === 0 && orderRow.status !== 'fulfilled', 'after all that, the order is still unshipped');
  check((await sentTo(getDb, target.customerEmail, { waitMs: 0 })).filter((m: any) => /has shipped/.test(m.subject)).length === 0, 'and no "shipped" email exists');

  console.log('\nBad input is refused');
  check((await call('/api/merchant/orders/ship', sA, { method: 'POST', body: { ref, carrier: 'ups', trackingNumber: '' } })).status === 400, 'no tracking number: 400');
  check((await call('/api/merchant/orders/ship', sA, { method: 'POST', body: { ref, carrier: 'pigeon', trackingNumber: '12345678' } })).status === 400, 'unknown carrier: 400');

  console.log('\nShipping it in the dashboard');
  const tracking = '1Z' + run.toUpperCase() + '0001';
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: 'goyunir_admin_device', value: sA, domain: 'app.goyunir.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    await page.goto(APP + '/app', { waitUntil: 'load' });
    await page.getByRole('button', { name: /^Orders/ }).click();
    await page.getByRole('button', { name: 'Open order ' + ref }).click();
    const panel = page.getByRole('region', { name: 'Order ' + ref });
    await panel.waitFor({ timeout: 20_000 });
    check(await panel.getByText(/To ship/).first().isVisible(), 'the order opens, marked "To ship"');
    await panel.getByLabel('Carrier').selectOption('ups');
    await panel.getByLabel('Tracking number').fill(tracking);
    await panel.getByRole('button', { name: 'Mark as shipped and email the customer' }).click();
    await panel.getByText(/The customer was emailed the tracking number/).waitFor({ timeout: 30_000 }).catch(() => {});
    const text = (await panel.innerText()).replace(/\s+/g, ' ');
    check(/Shipped .* with UPS/.test(text) && text.includes(tracking), 'it shows "Shipped with UPS" and the tracking number');
    check(/The customer was emailed the tracking number/.test(text), 'and that the customer was emailed');
    const trackHref = await panel.getByRole('link', { name: tracking }).getAttribute('href');
    check(trackHref === 'https://www.ups.com/track?tracknum=' + tracking, 'the tracking number links to UPS: ' + trackHref);
    const docWidth = await page.evaluate('document.documentElement.scrollWidth');
    check(Number(docWidth) <= 390, 'no sideways scroll at phone width (' + docWidth + 'px)');
  } finally {
    await browser.close();
  }

  console.log('\nRecorded once, emailed once, from the store');
  const f = ((await db.select<any>('order_fulfilments', { where: { order_id: eq(orderRow.id) } })) as any[]);
  check(f.length === 1 && f[0].tenant_id === A && f[0].tracking_number === tracking && f[0].carrier === 'UPS' && f[0].shipped_by === ownerA && Boolean(f[0].customer_emailed_at), 'one fulfilment row, test4\'s, by the owner: ' + JSON.stringify(f.map((x) => ({ carrier: x.carrier, tracking: x.tracking_number, by: x.shipped_by }))));
  check(((await db.select<any>('orders', { where: { id: eq(orderRow.id) }, select: ['status'] })) as any[])[0]?.status === 'fulfilled', 'the order status is "fulfilled"');
  const again = await call('/api/merchant/orders/ship', sA, { method: 'POST', body: { ref, carrier: 'fedex', trackingNumber: 'SECOND' + run } });
  const twice = await Promise.all([1, 2, 3].map(() => call('/api/merchant/orders/ship', sA, { method: 'POST', body: { ref, carrier: 'dhl', trackingNumber: 'RACE' + run } })));
  check(again.body?.result === 'already' && twice.every((r) => r.body?.result === 'already'), 'pressing again (and three at once): "already", nothing changes');
  const f2 = ((await db.select<any>('order_fulfilments', { where: { order_id: eq(orderRow.id) } })) as any[]);
  check(f2.length === 1 && f2[0].tracking_number === tracking, 'still one row with the first tracking number');
  const mails = (await sentTo(getDb, target.customerEmail, { waitMs: 15_000 })).filter((m: any) => /has shipped/.test(m.subject));
  const store = ((await db.select<any>('tenant_store_config', { where: { tenant_id: eq(A) }, select: ['config'], limit: 1 })) as any[])[0];
  const tenantName = ((await db.select<any>('tenants', { where: { id: eq(A) }, select: ['name'], limit: 1 })) as any[])[0]?.name;
  const storeName = String(store?.config?.branding?.brandName || tenantName || '');
  check(mails.length === 1, 'exactly one "shipped" email (recorded in the sink, not sent): ' + mails.length);
  const m = mails[0];
  check(Boolean(m) && String(m.from).startsWith('"' + storeName + '" <') && m.tenant_id === A, 'from the STORE (' + (m?.from || '?') + '), counted as test4\'s');
  check(Boolean(m) && String(m.html).includes(tracking) && String(m.html).includes('https://www.ups.com/track?tracknum=' + tracking) && String(m.html).includes(ref), 'it carries the order, tracking number and tracking link');

  console.log('\nAudit');
  const audit = (await db.select<any>('audit_logs', { where: { tenant_id: eq(A), created_at: gte(startedAt) }, select: ['action', 'detail', 'tenant_id'], limit: 50 })) as any[];
  const shipAudits = audit.filter((a) => /ORDER_SHIP/.test(String(a.action)));
  check(shipAudits.some((a) => a.action === 'MERCHANT_ORDER_SHIPPED') && shipAudits.every((a) => a.tenant_id === A), 'shipping is in the audit log, tagged test4: ' + shipAudits.map((a) => a.action).join(', '));
  const bAudit = (await db.select<any>('audit_logs', { where: { tenant_id: eq(B), created_at: gte(startedAt) }, select: ['action'], limit: 50 })) as any[];
  check(!bAudit.some((a) => /ORDER_SHIP/.test(String(a.action))), 'store B\'s refused attempts shipped nothing to audit');

  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
