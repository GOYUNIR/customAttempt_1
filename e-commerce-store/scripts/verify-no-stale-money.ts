/**
 * NO STALE MONEY: the storefront's catalog is cached for display (10s in the
 * Worker, lib/ttl-cache via /api/store), but what a buyer is CHARGED and
 * whether they CAN buy are read live at checkout. Proven on test4's fixture:
 *
 *   1. warm the display cache, change the price, check out at once:
 *      Stripe is asked for the NEW price;
 *   2. warm it again, set stock to 0, check out at once: refused;
 *   3. the pages and APIs that carry money or stock are never stored by a
 *      browser or the edge (cache-control on each).
 *
 *   npx tsx scripts/verify-no-stale-money.ts
 *
 * Restores the price and stock it found; expires the checkout it opened.
 */
import { ROOT } from './proof-config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';

const APP = 'https://app.' + ROOT;
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4 (Connect test store)
const STORE_A = 'https://test4.' + ROOT;
const PRODUCT = 'prod_tenant_test_1', SLUG = 'connect-test-item', SIZE = 'One Size';
const SINK = String(process.env.EMAIL_SINK_DOMAINS || '').split(',')[0].trim() || 'proof.invalid';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const { resolveStripeClient } = await import('../services/payment/factory');
  const { chargeRouteForTenant } = await import('../lib/connect');
  const { setStock, stockLevels } = await import('../lib/stock');
  const { resolveVariantId } = await import('../lib/inventory');
  const stripe: any = await resolveStripeClient();
  const route = await chargeRouteForTenant(A);
  if (route.route !== 'connected') throw new Error('test4 is not connected');
  const on = { stripeAccount: route.stripeAccount };
  const owner = ((await getDb().select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const tok = (await issueAdminDevice(createKvClient() as any, owner, false, deviceMetaFor((await readStaffIdentity(owner))!), 900)).token;
  const hdr = { origin: APP, cookie: 'goyunir_admin_device=' + tok, 'content-type': 'application/json' };
  const mine = async () => ((await (await fetch(APP + '/api/merchant/products', { headers: hdr })).json()).products || []).find((p: any) => p.id === PRODUCT);
  const savePrice = async (p: any, price: number) => {
    const payload = { id: p.id, name: p.name, slug: p.slug, tagline: p.tagline, description: p.description, isActive: p.isActive, isUpcoming: p.isUpcoming, releaseEndsAt: p.releaseEndsAt || '', maxPerEmail: p.maxPerEmail, sizes: p.sizes.map((s: any) => ({ size: s.size, price: s.size === SIZE ? price : Number(s.price), mode: s.mode })) };
    return (await fetch(APP + '/api/merchant/products', { method: 'POST', headers: hdr, body: JSON.stringify(payload) })).status;
  };
  const shown = async () => {
    const j: any = await (await fetch(STORE_A + '/api/store?slug=' + SLUG)).json();
    const p = j.product || (j.allProducts || []).find((x: any) => x.id === PRODUCT);
    const pc = (p?.priceCategories || []).find((c: any) => c.size === SIZE);
    return { price: Number(pc?.price), remaining: Number(p?.inventoryRemaining) };
  };
  const checkout = async (email: string) => {
    const r = await fetch(STORE_A + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE_A }, body: JSON.stringify({ productId: PRODUCT, size: SIZE, email, address: '1600 Pennsylvania Avenue NW, Washington, DC 20500, United States', mode: 'direct' }) });
    let body: any = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };

  const p0 = await mine();
  const price0 = Number(p0.sizes.find((s: any) => s.size === SIZE).price);
  const vid = (await resolveVariantId(A, PRODUCT, SIZE))!;
  const onHand0 = (await stockLevels(A, [vid])).get(vid)?.onHand ?? 0;
  const NEW = price0 + 4;
  const sessions: string[] = [];
  try {
    if (onHand0 < 1) await setStock(A, vid, 3, 'verify-no-stale-money', 'proof needs one unit');

    console.log('\n1. A price change reaches checkout at once');
    for (let i = 0; i < 3; i++) await shown(); // warm the display cache
    check(await savePrice(p0, NEW) === 200, 'price changed ' + price0 + ' -> ' + NEW);
    const display = await shown();
    console.log('     (the display right after the change shows ' + display.price + '; up to 10s old is allowed there)');
    const c1 = await checkout('price-' + run + '@' + SINK);
    const s1 = c1.body?.sessionId ? await stripe.checkout.sessions.retrieve(c1.body.sessionId, { expand: ['line_items'] }, on) : null;
    if (s1) sessions.push(s1.id);
    const unit = s1?.line_items?.data?.[0]?.price?.unit_amount;
    check(c1.status === 200 && unit === NEW * 100, 'Stripe is asked for the new price: ' + unit + ' cents (expected ' + NEW * 100 + ')');

    console.log('\n2. Sold out reaches checkout at once');
    for (let i = 0; i < 3; i++) await shown();
    const before = await shown();
    await setStock(A, vid, 0, 'verify-no-stale-money', 'sold-out proof');
    const after = await shown();
    console.log('     (the display showed ' + before.remaining + ' left before, ' + after.remaining + ' right after)');
    const c2 = await checkout('stock-' + run + '@' + SINK);
    if (c2.body?.sessionId) sessions.push(c2.body.sessionId);
    check(c2.status !== 200 && !c2.body?.sessionId, 'checkout is refused at once: ' + c2.status + ' ' + JSON.stringify(c2.body?.error || '').slice(0, 80));

    console.log('\n3. Nothing that carries money or stock is stored by a browser or the edge');
    const cc = async (url: string, init?: RequestInit) => ((await fetch(url, init)).headers.get('cache-control') || '');
    const noStore = (v: string) => /no-store|private|no-cache/.test(v);
    const noBrowser = (v: string) => !/max-age=[1-9]/.test(v.replace(/s-maxage=\d+/, ''));
    for (const [what, url] of [['store home', STORE_A + '/'], ['product page', STORE_A + '/' + SLUG], ['dashboard', APP + '/app']] as const) {
      const v = await cc(url);
      check(noStore(v), what + ' HTML: "' + v + '"');
    }
    const api = await cc(STORE_A + '/api/store?slug=' + SLUG);
    check(noBrowser(api), 'the catalog API has no browser max-age (browsers always ask again): "' + api + '"');
    const co = await fetch(STORE_A + '/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json', origin: STORE_A }, body: '{}' });
    check(noStore(co.headers.get('cache-control') || '') || co.status >= 400, 'checkout is a POST (never cached): ' + co.status);
    const stockApi = await cc(APP + '/api/merchant/products', { headers: hdr });
    check(noStore(stockApi), 'the dashboard\'s products/stock API: "' + stockApi + '"');
  } finally {
    for (const id of sessions) await stripe.checkout.sessions.expire(id, {}, on).catch(() => null);
    const p = await mine();
    await savePrice(p, price0);
    await setStock(A, vid, Math.max(onHand0, 0), 'verify-no-stale-money', 'restore');
  }
  const p1 = await mine();
  check(Number(p1.sizes.find((s: any) => s.size === SIZE).price) === price0, 'price restored to ' + price0);
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
