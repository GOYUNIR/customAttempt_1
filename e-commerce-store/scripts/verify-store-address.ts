/**
 * SELF-SERVE STORE ADDRESS — live proof (STORE-ADDRESSES.md §A, 00039).
 *
 *   npx tsx scripts/verify-store-address.ts
 *
 * On store B (a proof store): availability answers, lookalike/reserved/taken
 * names refused, a change goes live and the old address 301s, another store
 * cannot take the held old name, switching back works, the 3-per-30-days cap
 * holds, and the final switch back is made through the real dashboard. Store B
 * ends on its original address; its proof change history is cleared so the
 * proof can run again (a proof store only).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const APP = 'https://app.goyunir.com';
const ROOT = 'goyunir.com';
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4
const B = 'ff8d5e59-1a07-4e83-bc13-f949c745d9de'; // goyunir-test-1
const B_OWNER = 'isolation-owner-b@goyunir.invalid';
const ORIGINAL = 'goyunir-test-1';
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
  const db = getDb(); const kv: any = createKvClient();
  const ownerA = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const sA = (await issueAdminDevice(kv, ownerA, false, deviceMetaFor((await readStaffIdentity(ownerA))!), 900)).token;
  const sB = (await issueAdminDevice(kv, B_OWNER, false, deviceMetaFor((await readStaffIdentity(B_OWNER))!), 900)).token;
  const h = (tok: string, json = false) => ({ origin: APP, cookie: 'goyunir_admin_device=' + tok, ...(json ? { 'content-type': 'application/json' } : {}) });
  const check_ = async (tok: string, slug: string) => (await (await fetch(APP + '/api/merchant/address?slug=' + encodeURIComponent(slug), { headers: h(tok) })).json()).candidate;
  const move = async (tok: string, slug: string) => { const r = await fetch(APP + '/api/merchant/address', { method: 'POST', headers: h(tok, true), body: JSON.stringify({ slug }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const slugOf = async (t: string) => ((await db.select<any>('tenants', { where: { id: eq(t) }, select: ['slug'], limit: 1 })) as any[])[0]?.slug;
  const cleanup = async () => {
    await db.remove('tenant_slug_changes', { where: { tenant_id: eq(B) } }).catch(() => null);
    await db.remove('tenant_slug_aliases', { where: { tenant_id: eq(B) } }).catch(() => null);
  };
  const NEW1 = 'proof-' + run;
  const NEW2 = 'proof-' + run + '-b';

  try {
    await cleanup();
    if ((await slugOf(B)) !== ORIGINAL) throw new Error('store B is not on ' + ORIGINAL + ' before the proof: ' + (await slugOf(B)));
    console.log('\nAvailability');
    const refusals: [string, RegExp][] = [['paypa1-help', /brand/], ['admin', /reserved/], ['test4', /Another store/], ['ab', /at least 3/]];
    for (const [s, re] of refusals) { const c = await check_(sB, s); check(c?.available === false && re.test(c.reason), JSON.stringify(s) + ' refused: ' + c?.reason); }
    const free = await check_(sB, NEW1);
    check(free?.available === true && free.url === 'https://' + NEW1 + '.' + ROOT, 'a free name is available, with its preview URL: ' + free?.url);

    console.log('\nChange');
    const r1 = await move(sB, NEW1);
    check(r1.status === 200 && (await slugOf(B)) === NEW1, 'the owner moves store B to ' + NEW1 + ': ' + r1.status);
    let newOk = false; for (let i = 0; i < 20 && !newOk; i++) { newOk = (await fetch('https://' + NEW1 + '.' + ROOT + '/', { redirect: 'manual' })).status === 200; if (!newOk) await sleep(5000); }
    check(newOk, 'the new address serves the store');
    let redirect = ''; for (let i = 0; i < 20 && !redirect.startsWith('https://' + NEW1); i++) {
      const res = await fetch('https://' + ORIGINAL + '.' + ROOT + '/catalog', { redirect: 'manual' });
      redirect = String(res.headers.get('location') || ''); if (!redirect.startsWith('https://' + NEW1)) await sleep(5000);
    }
    check(redirect === 'https://' + NEW1 + '.' + ROOT + '/catalog', 'the old address permanently redirects, keeping the path: ' + redirect);
    const held = await check_(sA, ORIGINAL);
    check(held?.available === false && /recently/.test(held.reason), 'test4 sees the old name as held: ' + held?.reason);
    check((await move(sA, ORIGINAL)).status === 409 && (await slugOf(A)) === 'test4', 'and cannot take it (409); test4 unchanged');

    console.log('\nSwitch back and the cap');
    const back = await check_(sB, ORIGINAL);
    check(back?.available === true && /previous address/.test(back.reason), 'store B may switch back to its own held name: ' + back?.reason);
    check((await move(sB, ORIGINAL)).status === 200 && (await slugOf(B)) === ORIGINAL, 'switched back');
    check((await move(sB, NEW2)).status === 200, 'third change in 30 days is allowed');
    const fourth = await move(sB, ORIGINAL);
    check(fourth.status === 429 && (await slugOf(B)) === NEW2, 'the fourth is refused (429): ' + fourth.body?.error);

    console.log('\nIn the dashboard');
    await db.remove('tenant_slug_changes', { where: { tenant_id: eq(B) } });  // proof store: lift the cap for the last step
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addCookies([{ name: 'goyunir_admin_device', value: sB, domain: 'app.goyunir.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      await page.goto(APP + '/app', { waitUntil: 'load' });
      await page.getByRole('button', { name: /^Settings$/ }).click();
      const box = page.getByRole('region', { name: 'Store address' }).locator('input');
      await box.fill('Pay Pal');
      const warn = await page.getByRole('status').filter({ hasText: /brand/ }).first().innerText({ timeout: 15_000 }).catch(() => '');
      check(/brand/.test(warn) && (await box.inputValue()) === 'pay-pal', 'typing "Pay Pal" shows "pay-pal" and explains why it is refused');
      await box.fill(ORIGINAL);
      const moveBtn = page.getByRole('button', { name: 'Move my store to ' + ORIGINAL + '.' + ROOT });
      await moveBtn.waitFor({ timeout: 15_000 });
      check(true, 'a free name shows its preview and a button that says what it does: "Move my store to ' + ORIGINAL + '.' + ROOT + '"');
      await moveBtn.click();
      const done = await page.getByText(/Your store is now at/).first().innerText({ timeout: 20_000 }).catch(() => '');
      check(/Your store is now at https:\/\/goyunir-test-1/.test(done) && (await slugOf(B)) === ORIGINAL, 'the change made in the dashboard went live: ' + done.slice(0, 120));
    } finally { await browser.close(); }
  } finally {
    if ((await slugOf(B)) !== ORIGINAL) await db.update('tenants', { where: { id: eq(B) } }, { slug: ORIGINAL }, { returning: 'minimal' } as any);
    await cleanup();
    console.log('\ncleanup: store B on ' + (await slugOf(B)) + ', proof aliases and change log removed');
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
