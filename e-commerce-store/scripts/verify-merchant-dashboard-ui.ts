/**
 * MERCHANT DASHBOARD UI CHECK (app/app/page.tsx), on production.
 *   npx tsx scripts/verify-merchant-dashboard-ui.ts
 * Real Chrome at phone width with real merchant sessions (issued as the
 * verified sign-in issues them, deleted after): the page shows the signed-in
 * store's own data; a product created through the FORM lands in that store's
 * catalog and on that store's own storefront address, and nowhere else;
 * signed-out visitors are sent to the sign-in page.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
process.env.USE_POSTGRES_PRIMARY = process.env.USE_POSTGRES_PRIMARY || 'true';
import { chromium } from 'playwright-core';
import { CHROME, IPHONE_UA } from './mobile-audit';

const OUT = join(process.cwd(), 'tenant-checkout-out');
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  mkdirSync(OUT, { recursive: true });
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient, loadProducts } = await import('../lib/server-config');
  const { ADMIN_DEVICES_KEY } = await import('../lib/redis-keys');
  const { DEFAULT_TENANT_ID } = await import('../lib/default-tenant');
  const kv: any = createKvClient();
  const aEmail = ((await getDb().select<any>('users', { where: { tenant_id: eq('13591c9e-82e4-4c23-8d94-249cef6fa775'), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const idA = await readStaffIdentity(aEmail);
  const idB = await readStaffIdentity('isolation-owner-b@goyunir.invalid');
  const sA = (await issueAdminDevice(kv, aEmail, false, deviceMetaFor(idA!), 600)).token;
  const sB = (await issueAdminDevice(kv, idB!.email, false, deviceMetaFor(idB!), 600)).token;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const open = async (token: string | null) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
    if (token) await ctx.addCookies([{ name: 'goyunir_admin_device', value: token, domain: 'app.goyunir.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    return { ctx, page: await ctx.newPage() };
  };
  try {
    console.log('\nSigned out');
    { const { ctx, page } = await open(null);
      await page.goto('https://app.goyunir.com/app', { waitUntil: 'load' }); await page.waitForTimeout(3000);
      check(/\/app\/login/.test(page.url()), 'a signed-out visitor is sent to the merchant sign-in: ' + page.url());
      await ctx.close(); }

    console.log('\ntest4 owner');
    { const { ctx, page } = await open(sA);
      await page.goto('https://app.goyunir.com/', { waitUntil: 'load' }); await page.waitForTimeout(3500);
      const text = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(OUT, 'dash-test4.png'), fullPage: true });
      check(/test4/.test(text) && /Connect Test Item/.test(text), 'the portal root shows test4\'s dashboard with its products');
      check(!/Black Solstice|Roccstar|Isolation B Tee/.test(text), 'and nothing from the original store or store B');
      check(/Payments/.test(text) && /straight into your Stripe account/.test(text), 'payments show as on');
      await page.getByRole('button', { name: /^Orders/ }).tap(); await page.waitForTimeout(800);
      const orders = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(OUT, 'dash-test4-orders.png'), fullPage: true });
      check(/TEST-/.test(orders), 'test4\'s orders are listed');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(!overflow, 'no sideways scrolling at 390px');
      const wide = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

      await page.getByRole('button', { name: /^Raffles & waitlists/ }).tap(); await page.waitForTimeout(1000);
      const drops = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(OUT, 'dash-test4-drops.png'), fullPage: true });
      check(/Connect Test Raffle/.test(drops) && /Run due draws now/.test(drops) && /Recent draws/.test(drops), 'the raffles tab lists test4\'s raffle, its recent draws, and the run button');
      check(!(await wide()), 'raffles tab: no sideways scrolling');
      await page.getByRole('button', { name: 'Entries' }).first().tap(); await page.waitForTimeout(1500);
      const ent = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(OUT, 'dash-test4-entries.png'), fullPage: true });
      check(/@goyunir\.invalid/.test(ent) && /(charged|pending|declined|cancelled)/.test(ent) && !/pm_|cus_/.test(ent), 'entries show email and status, no card ids');
      check(!(await wide()), 'entries: no sideways scrolling');
      await page.getByRole('button', { name: 'Back' }).tap(); await page.waitForTimeout(400);

      await page.getByRole('button', { name: /^Staff$/ }).tap(); await page.waitForTimeout(800);
      const staff = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(OUT, 'dash-test4-staff.png'), fullPage: true });
      check(/People who can run this store/.test(staff) && staff.includes(aEmail) && /Send invitation/.test(staff), 'the owner sees the staff tab: themselves, and the invite form');
      check(!/isolation-owner-b/.test(staff), 'and no one from store B');
      check(!(await wide()), 'staff tab: no sideways scrolling');

      // Stock tools, on the hidden fixture (never on sale).
      await page.getByRole('button', { name: /^Products/ }).tap(); await page.waitForTimeout(600);
      const listText = await page.evaluate(() => document.body.innerText);
      check(/available/.test(listText), 'the product list shows available stock per size');
      const row = page.locator('div', { hasText: /^Stock race fixture \(hidden\)/ }).locator('xpath=ancestor::div[button][1]');
      await row.getByRole('button', { name: 'Edit' }).first().tap(); await page.waitForTimeout(800);
      await page.getByLabel('Counted units for One').fill('3');
      await page.getByRole('button', { name: 'Set count' }).first().tap(); await page.waitForTimeout(2500);
      const afterCount = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(OUT, 'dash-test4-stock.png'), fullPage: true });
      check(/Count saved: 3 on hand/.test(afterCount) && /3 on hand · 0 in checkout · 3 available/.test(afterCount), 'counting 3 in the editor saves and shows 3 on hand / 3 available');
      await page.getByRole('button', { name: 'History' }).first().tap(); await page.waitForTimeout(1500);
      const hist = await page.evaluate(() => document.body.innerText);
      check(/counted \+?\d+ → 3/.test(hist) && hist.includes(aEmail), 'the history shows the count, by the owner');
      check(!(await wide()), 'stock editor: no sideways scrolling');
      await page.getByLabel('Units to add or remove for One').fill('3');
      await page.getByRole('button', { name: 'Remove' }).first().tap(); await page.waitForTimeout(2500);
      check(/Stock removed: 0 on hand/.test(await page.evaluate(() => document.body.innerText)), 'removing 3 brings it back to 0');
      await ctx.close(); }

    console.log('\nSign out');
    { const sOut = (await issueAdminDevice(kv, aEmail, false, deviceMetaFor(idA!), 600)).token;
      const { ctx, page } = await open(sOut);
      await page.goto('https://app.goyunir.com/app', { waitUntil: 'load' }); await page.waitForTimeout(3000);
      await page.getByRole('button', { name: 'Sign out' }).tap(); await page.waitForTimeout(2500);
      check(/\/app\/login/.test(page.url()), 'tapping Sign out lands on the merchant sign-in: ' + page.url());
      const after = await fetch('https://app.goyunir.com/api/merchant/store', { headers: { cookie: 'goyunir_admin_device=' + sOut } });
      check(after.status === 401, 'and that session is dead on the server too: ' + after.status);
      await ctx.close(); }

    console.log('\nstore B creates a product through the form');
    const name = 'Form Made Cap ' + Date.now().toString(36);
    { const { ctx, page } = await open(sB);
      await page.goto('https://app.goyunir.com/app', { waitUntil: 'load' }); await page.waitForTimeout(3500);
      await page.getByRole('button', { name: 'New product' }).tap();
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page.getByLabel('Price').first().fill('17.50');
      await page.getByLabel('Starting stock').first().fill('6');
      await page.getByText('On sale', { exact: true }).tap();
      await page.screenshot({ path: join(OUT, 'dash-b-form.png'), fullPage: true });
      await page.getByRole('button', { name: 'Save' }).tap();
      // Wait for the refreshed list rather than a fixed sleep (a fixed 3.5s
      // read the page mid-refresh once the list grew; the screenshot a moment
      // later showed the product was there).
      await page.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 15_000 }).catch(() => {});
      const text = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: join(OUT, 'dash-b-after.png'), fullPage: true });
      check(text.includes(name) && /Product created/.test(text), 'the product appears in store B\'s dashboard');
      await ctx.close(); }
    const bProducts = Object.values(await loadProducts(null, { tenantId: idB!.tenantId! })) as any[];
    const made = bProducts.find((p) => p.name === name);
    check(Boolean(made) && made.priceCategories[0].price === 17.5 && made.priceCategories[0].liveStock === 6 && made.isActive === true, 'written to store B\'s catalog: 17.50, 6 in stock, on sale');
    const aProducts = Object.values(await loadProducts(null, { tenantId: idA!.tenantId! })) as any[];
    const dProducts = Object.values(await loadProducts(null, { tenantId: DEFAULT_TENANT_ID } as any)) as any[];
    check(!aProducts.some((p) => p.name === name) && !dProducts.some((p) => p.name === name), 'not in test4\'s catalog, not in the original store\'s');
    const storeB = await fetch('https://goyunir-test-1.goyunir.com/api/store').then((r) => r.json());
    const storeA = await fetch('https://test4.goyunir.com/api/store').then((r) => r.json());
    const storeD = await fetch('https://shop.goyunir.com/api/store').then((r) => r.json());
    check((storeB.allProducts || []).some((p: any) => p.name === name), 'it is live on store B\'s own address');
    check(!(storeA.allProducts || []).some((p: any) => p.name === name) && !(storeD.allProducts || []).some((p: any) => p.name === name), 'and not on test4\'s or the original store\'s');
  } finally {
    await browser.close();
    await kv.hdel(ADMIN_DEVICES_KEY, sA); await kv.hdel(ADMIN_DEVICES_KEY, sB);
    console.log('\nsessions deleted');
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e?.message || e); process.exit(1); });
