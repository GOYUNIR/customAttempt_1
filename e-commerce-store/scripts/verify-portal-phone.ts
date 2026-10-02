/**
 * PORTALS AT PHONE WIDTH (components/admin/PortalShell.tsx, shared by the
 * platform admin and sales portals): at 375, 390 and 414px the sidebar is a
 * drawer behind "Menu", the content gets the full width, nothing scrolls
 * sideways, and picking a destination closes the drawer.
 *
 *   npx tsx scripts/verify-portal-phone.ts
 *
 * Uses a temporary sales account made through the real invite + accept flow
 * (a proof address; the release gate's teardown removes it).
 */
import { ROOT } from './proof-config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const SALES = 'https://sales.' + ROOT;
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  const { createInvite } = await import('../lib/staff-invites');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const email = 'phone-sales-' + Date.now() + '@goyunir.invalid';
  const inv: any = await createInvite({ email, role: 'sales', tenantId: null, invitedByEmail: 'portal-proof@goyunir.invalid' });
  const acc = await fetch(SALES + '/api/admin/accept-invite', { method: 'POST', headers: { 'content-type': 'application/json', origin: SALES }, body: JSON.stringify({ token: inv.token, password: 'Ph-' + crypto.randomUUID() + '-Aa1!' }) });
  const id = await readStaffIdentity(email);
  if (acc.status !== 200 || !id) throw new Error('could not make the sales account: ' + acc.status);
  const token = (await issueAdminDevice(createKvClient() as any, email, false, deviceMetaFor(id), 600)).token;

  console.log('\nThe Sales Hub\'s APIs answer on the sales host (they 404\'d there until 2026-10-02)');
  const hdr = { cookie: 'goyunir_admin_device=' + token, origin: SALES };
  const pick = await fetch(SALES + '/api/admin/sales/picklists', { headers: hdr });
  const pickBody: any = await pick.json().catch(() => null);
  check(pick.status === 200 && pickBody?.email === email && Array.isArray(pickBody?.stores), 'pick-lists: 200, signed in as the rep, stores by name (' + (pickBody?.stores?.length ?? '?') + ' assigned)');
  check((await fetch(SALES + '/api/admin/b2b/price-list', { headers: hdr })).status === 400, 'Volume Pricing\'s API answers (400: choose a company), not 404');
  check((await fetch(SALES + '/api/admin/sales/picklists')).status === 401, 'without a session: 401');

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const width of [375, 390, 414]) {
      console.log('\n' + width + 'px');
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await ctx.addCookies([{ name: 'goyunir_admin_device', value: token, domain: 'sales.' + ROOT, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      await page.goto(SALES + '/sales', { waitUntil: 'load' });
      const menu = page.getByRole('button', { name: 'Menu' });
      await menu.waitFor({ timeout: 30_000 });
      const aside = page.locator('#portal-menu');
      const geo = async () => page.evaluate(`(() => { var a = document.getElementById('portal-menu').getBoundingClientRect(); var m = document.querySelector('main').getBoundingClientRect(); return { asideRight: a.right, mainWidth: m.width, scroll: document.documentElement.scrollWidth }; })()`) as Promise<any>;
      const closed = await geo();
      check(closed.asideRight <= 0, 'the sidebar is out of the way (drawer closed)');
      check(closed.mainWidth >= width - 2, 'the content gets the full width: ' + Math.round(closed.mainWidth) + 'px of ' + width + ' (was about 135px)');
      check(closed.scroll <= width, 'no sideways scroll (' + closed.scroll + 'px)');
      await menu.tap();
      await page.waitForTimeout(400);
      const open = await geo();
      check(open.asideRight > 200 && await aside.isVisible(), 'Menu opens the drawer');
      const item = aside.locator('nav a, nav button').first();
      const label = (await item.innerText()).trim();
      await item.tap();
      await page.waitForTimeout(600);
      check((await geo()).asideRight <= 0, 'picking "' + label + '" closes it');
      await page.screenshot({ path: join(process.cwd(), 'tenant-checkout-out', 'portal-' + width + '.png') });
      await ctx.close();
    }
    console.log('\nDesktop (1280px)');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: 'goyunir_admin_device', value: token, domain: 'sales.' + ROOT, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    await page.goto(SALES + '/sales', { waitUntil: 'load' });
    await page.locator('#portal-menu').waitFor({ timeout: 30_000 });
    check(!(await page.getByRole('button', { name: 'Menu' }).isVisible()) && (await page.locator('#portal-menu').boundingBox())!.x === 0, 'the sidebar stays put and there is no Menu button');
  } finally {
    await browser.close();
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
