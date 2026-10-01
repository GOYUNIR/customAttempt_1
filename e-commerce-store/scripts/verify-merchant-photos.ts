/**
 * MERCHANT PRODUCT PHOTOS — isolation and correctness proof, live.
 *
 *   npx tsx scripts/verify-merchant-photos.ts
 *
 * A store uploads a photo (a fresh, unique image drawn for this run) and puts
 * it on its product through the real dashboard; another store cannot use it,
 * cannot upload for it, and nothing that is not a real photo gets stored.
 * Uses test4's hidden draft fixture (never shown to shoppers) and leaves its
 * photos as they were. Uploaded test objects stay in storage (unreferenced).
 */
import { ROOT, ROOT_RE, SUPPORT_EMAIL } from './proof-config';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const APP = 'https://app.' + ROOT;
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const kv: any = createKvClient();
  const ownerA = ((await getDb().select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sA = (await issueAdminDevice(kv, ownerA, false, deviceMetaFor((await readStaffIdentity(ownerA))!), 900)).token;
  const sB = (await issueAdminDevice(kv, B_OWNER, false, deviceMetaFor((await readStaffIdentity(B_OWNER))!), 900)).token;
  const hdr = (tok: string | null, extra: Record<string, string> = {}) => ({ origin: APP, ...(tok ? { cookie: 'goyunir_admin_device=' + tok } : {}), ...extra });
  const upload = async (tok: string | null, bytes: Uint8Array, name: string, type: string) => {
    const fd = new FormData(); fd.append('file', new Blob([bytes as any], { type }), name);
    const r = await fetch(APP + '/api/merchant/media', { method: 'POST', headers: hdr(tok), body: fd });
    let body: any = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };
  const products = async (tok: string) => ((await (await fetch(APP + '/api/merchant/products', { headers: hdr(tok) })).json()).products || []) as any[];
  const save = async (tok: string, p: any, extra: Record<string, unknown>) => {
    const payload = { id: p.id, name: p.name, slug: p.slug, tagline: p.tagline, description: p.description, isActive: p.isActive, isUpcoming: p.isUpcoming, releaseEndsAt: p.releaseEndsAt || '', maxPerEmail: p.maxPerEmail, sizes: p.sizes.map((s: any) => ({ size: s.size, price: Number(s.price), mode: s.mode, ...(s.winners ? { winners: Number(s.winners) } : {}) })), ...extra };
    const r = await fetch(APP + '/api/merchant/products', { method: 'POST', headers: hdr(tok, { 'content-type': 'application/json' }), body: JSON.stringify(payload) });
    let body: any = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };

  // A unique photo for this run, drawn in a real browser.
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const scratch = await browser.newPage();
  const dataUrl: string = await scratch.evaluate(`(() => { var c = document.createElement('canvas'); c.width = 640; c.height = 800; var g = c.getContext('2d'); g.fillStyle = 'hsl(${parseInt(run.slice(-3), 36) % 360}, 45%, 55%)'; g.fillRect(0, 0, 640, 800); g.fillStyle = '#fff'; g.font = 'bold 44px sans-serif'; g.fillText('photo proof ${run}', 40, 400); return c.toDataURL('image/png'); })()`);
  const png = new Uint8Array(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const dir = join(process.cwd(), 'tenant-checkout-out'); mkdirSync(dir, { recursive: true });
  const pngPath = join(dir, 'proof-photo-' + run + '.png'); writeFileSync(pngPath, png);

  try {
    console.log('\nUpload');
    check((await upload(null, png, 'a.png', 'image/png')).status === 401, 'no session: refused (401)');
    const up = await upload(sA, png, 'my photo.png', 'image/png');
    const url = String(up.body?.url || '');
    check(up.status === 201 && url.includes('/tenants/' + A + '/products/') && url.endsWith('.png'), 'test4 uploads a photo: stored under test4\'s own folder, key chosen by the server: ' + url.replace(/^.*\/tenants\//, 'tenants/'));
    const got = await fetch(url);
    const back = new Uint8Array(await got.arrayBuffer());
    check(got.status === 200 && /image\/png/.test(String(got.headers.get('content-type'))) && Buffer.compare(Buffer.from(back), Buffer.from(png)) === 0, 'it is served publicly, byte-for-byte, as image/png');
    const html = new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>' + ' '.repeat(40));
    check((await upload(sA, html, 'innocent.jpg', 'image/jpeg')).status === 415, 'an HTML file named .jpg and labelled image/jpeg is refused (415)');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    check((await upload(sA, svg, 'logo.svg', 'image/svg+xml')).status === 415, 'an SVG (can carry script) is refused (415)');
    const big = new Uint8Array(8 * 1024 * 1024 + 10); big.set([0xff, 0xd8, 0xff, 0xe0]);
    check((await upload(sA, big, 'huge.jpg', 'image/jpeg')).status === 413, 'over 8 MB is refused (413)');

    console.log('\nOnly a store\'s own photos');
    const pA = (await products(sA)).find((p) => p.slug === 'stock-race-fixture');
    const pB = (await products(sB))[0];
    if (!pA || !pB) throw new Error('fixtures missing: ' + JSON.stringify({ a: !!pA, b: !!pB }));
    const beforeB = JSON.stringify(pB.images || []);
    const steal = await save(sB, pB, { images: [url] });
    check(steal.status === 400, 'store B cannot put test4\'s photo on its own product: ' + steal.status + ' ' + JSON.stringify(steal.body?.error));
    check(JSON.stringify(((await products(sB)).find((p) => p.id === pB.id) || {}).images || []) === beforeB, 'store B\'s product is unchanged');
    const upB = await upload(sB, png, 'b.png', 'image/png');
    check(upB.status === 201 && String(upB.body?.url).includes('/tenants/' + B + '/'), 'store B\'s own upload lands in store B\'s folder');
    check((await save(sA, pA, { images: [upB.body?.url] })).status === 400, 'and test4 cannot use store B\'s photo either');
    check((await save(sA, pA, { images: ['https://example.com/x.png'] })).status === 400, 'a photo from another website is refused');

    console.log('\nIn the dashboard');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: 'goyunir_admin_device', value: sA, domain: 'app.' + ROOT, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    await page.goto(APP + '/app', { waitUntil: 'load' });
    await page.getByRole('button', { name: /^Products/ }).waitFor({ timeout: 30_000 });
    const row = page.locator('div').filter({ hasText: pA.name }).filter({ has: page.getByRole('button', { name: 'Edit' }) }).last();
    await row.getByRole('button', { name: 'Edit' }).click();
    await page.locator('input[type=file]').setInputFiles(pngPath);
    await page.getByRole('button', { name: /Remove photo 1/ }).waitFor({ timeout: 30_000 });
    check(await page.locator('img[alt="Photo 1"]').count() === 1, 'choosing a file uploads it and shows its thumbnail');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(3000);
    const saved = (await products(sA)).find((p) => p.id === pA.id);
    check((saved?.images || []).length === 1 && String(saved.images[0]).includes('/tenants/' + A + '/'), 'Save puts it on the product: ' + JSON.stringify(saved?.images));

    console.log('\nStored as a domain-free key, resolved when read (lib/media-key)');
    const row0 = ((await getDb().select<any>('products', { where: { tenant_id: eq(A), slug: eq('stock-race-fixture') }, select: ['media_gallery'], limit: 1 })) as any[])[0];
    const stored = String(row0?.media_gallery?.[0]?.url || '');
    check(/^media:tenants\/[0-9a-f-]+\/products\/[0-9a-f]+\.png$/.test(stored) && stored.includes(A) && !/https?:/.test(stored), 'the database holds the key, no domain: ' + stored);
    const shown = String(saved?.images?.[0] || '');
    const viaRead = await fetch(shown);
    check(viaRead.status === 200 && Buffer.compare(Buffer.from(new Uint8Array(await viaRead.arrayBuffer())), Buffer.from(png)) === 0, 'read back, it resolves to a working URL serving the same bytes: ' + shown.replace(/\/tenants\/.*/, '/…'));
    const keyA = stored.slice('media:'.length);
    const base = shown.slice(0, shown.indexOf('/' + keyA));
    for (const [what, img] of [
      ['test4\'s key, by name', stored],
      ['a ".." walk out of store B\'s own folder', 'media:tenants/' + B + '/products/../../' + A + '/products/' + keyA.split('/').pop()],
      ['the same walk as a URL', base + '/tenants/' + B + '/products/../../' + A + '/products/' + keyA.split('/').pop()],
      ['an encoded walk', base + '/tenants/' + B + '/products/%2e%2e/%2e%2e/' + A + '/products/' + keyA.split('/').pop()],
    ] as const) check((await save(sB, pB, { images: [img] })).status === 400, 'store B cannot use ' + what);
    check(JSON.stringify(((await products(sB)).find((p) => p.id === pB.id) || {}).images || []) === beforeB, 'store B\'s product is still unchanged');
    // Older photos: the demo store's were saved as full URLs before keys existed.
    const DEMO = '3b6f7db1-7645-4c52-aefe-cc8be563c359';
    const legacy = ((await getDb().select<any>('products', { where: { tenant_id: eq(DEMO), status: eq('live') }, select: ['media_gallery'] })) as any[])
      .flatMap((p) => (p.media_gallery || []).map((m: any) => String(m?.url || ''))).filter((u: string) => /^https:\/\//.test(u));
    const demoPage = await (await fetch('https://demo.' + ROOT + '/api/store')).text();
    check(legacy.length > 0 && legacy.every((u: string) => demoPage.includes(u)) && (await fetch(legacy[0])).status === 200, 'older photos stored as full URLs are served exactly as stored (' + legacy.length + ' on the demo storefront)');
    const bShown = (await products(sB)).flatMap((p) => p.images || []);
    check(!bShown.some((u: string) => u.includes('/tenants/' + A + '/')) && !demoPage.includes(A), 'nothing of test4\'s appears in another store\'s catalog');

    const keep = await save(sA, saved, {});
    check(keep.status === 200 && ((await products(sA)).find((p) => p.id === pA.id)?.images || []).length === 1, 'a later edit that does not touch photos keeps them');
    const clear = await save(sA, saved, { images: pA.images || [] });
    check(clear.status === 200 && JSON.stringify((await products(sA)).find((p) => p.id === pA.id)?.images || []) === JSON.stringify(pA.images || []), 'the fixture is back to its original photos');
  } finally {
    await browser.close();
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
