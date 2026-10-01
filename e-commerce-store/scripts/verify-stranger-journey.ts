/**
 * A STRANGER OPENS A STORE, hands-off, on production: real browser, real
 * Turnstile (production key), real email, no operator.
 *
 *   npx tsx scripts/verify-stranger-journey.ts            (needs ALLOW_MERCHANT_SIGNUP=true live)
 *
 * signup form → verify email → choose password → sign in (emailed code) →
 * dashboard checklist → first product with a photo → Connect payments starts
 * (Stripe's own form has a CAPTCHA: that step is the merchant's, by design) →
 * the resume path is there → store address and plan screens reachable →
 * support address visible. The store gets a unique made-up name; it is a
 * Free store with no payments, so it releases its name by itself after the
 * activation window (policy data) — nothing is left for the operator.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium, type Page } from 'playwright-core';
import { CHROME } from './mobile-audit';

const ROOT = 'https://goyunir.com';
const APP = 'https://app.goyunir.com';
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);
const NAMES = ['Kestrel', 'Juniper', 'Marrow', 'Tidewater', 'Lumen', 'Corvid', 'Saffron', 'Hollow Oak'];
const storeName = NAMES[parseInt(run.slice(-2), 36) % NAMES.length] + ' Ceramics ' + run.slice(-4);
const email = 'delivered+stranger' + run + '@resend.dev';
const password = 'Stranger-' + crypto.randomUUID() + '-Aa1!';

async function waitForTurnstile(page: Page, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await page.evaluate("(() => { var i = document.querySelector('input[name=\"cf-turnstile-response\"]'); return i ? i.value : ''; })()").catch(() => '');
    if (v) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { sentTo } = await import('./resend-readback');
  const browser = await chromium.launch({ executablePath: CHROME, headless: false });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    console.log('\nSignup (real form, real Turnstile) — ' + storeName);
    await page.goto(ROOT + '/#start', { waitUntil: 'load' });
    await page.getByPlaceholder('Atelier Nord').fill(storeName);
    await page.getByPlaceholder('you@brand.com').fill(email);
    const preview = await page.getByText(/Your store: .*\.goyunir\.com/).innerText().catch(() => '');
    check(/Your store: [a-z0-9-]+\.goyunir\.com/.test(preview), 'the address is previewed as you type: ' + preview);
    await page.locator('input[type=checkbox]').first().check();
    check(await waitForTurnstile(page), 'Turnstile issued a token for a real browser');
    await page.getByRole('button', { name: /Email me a link/ }).click();
    const done = await page.getByText('Check your email').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    check(done, 'the form says to check your email');

    console.log('\nVerify email → choose password');
    const mail = (await sentTo(getDb, email, { waitMs: 90_000 }))[0];
    const link = (String(mail?.html || mail?.text || '').match(/https:\/\/goyunir\.com\/api\/signup\/merchant\/complete\?token=[0-9a-f]{64}/) || [])[0] || '';
    check(Boolean(link) && /Confirm your email to open/.test(mail?.subject || ''), 'the email arrived with its link: "' + (mail?.subject || 'none') + '"');
    await page.goto(link, { waitUntil: 'load' });
    check(/\/admin\/accept-invite\?token=/.test(page.url()), 'the link creates the store and opens "choose a password": ' + new URL(page.url()).host);
    const pw = page.locator('input[type=password]');
    await pw.first().waitFor({ timeout: 20_000 });
    for (let i = 0; i < await pw.count(); i++) await pw.nth(i).fill(password);
    await page.getByRole('button', { name: /accept|create|set|continue|join/i }).first().click();
    await page.getByText(/all set|ready/i).first().waitFor({ timeout: 20_000 }).catch(() => {});

    console.log('\nSign in (password + emailed code)');
    const since = Date.now();
    await page.goto(APP + '/app/login', { waitUntil: 'load' });
    await page.locator('input[type=email]').first().fill(email);
    await page.locator('input[type=password]').first().fill(password);
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    const codeBox = page.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]').first();
    await codeBox.waitFor({ timeout: 30_000 });
    const codeMail = (await sentTo(getDb, email, { waitMs: 60_000 })).find((m: any) => Date.parse(m.created_at) >= since - 5000 && /sign-in code/i.test(m.subject));
    const code = (String(codeMail?.subject || '').match(/(\d{6})/) || [])[1] || '';
    await codeBox.fill(code);
    await page.getByRole('button', { name: /verify|confirm|continue|sign in/i }).last().click();
    await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 30_000 });
    check(page.url().startsWith(APP + '/app'), 'signed in to the new store\'s dashboard');

    console.log('\nDashboard checklist');
    const list = page.getByRole('region', { name: 'Get your store ready' });
    const listText = (await list.innerText({ timeout: 15_000 }).catch(() => '')).replace(/\s+/g, ' ');
    check(/Connect payments/.test(listText) && /Add your first product/.test(listText) && /store address/.test(listText) && /plan/i.test(listText), 'the checklist shows the four steps: ' + listText.slice(0, 160));
    check(/support@goyunir\.com/.test(listText), 'and where to get help (support@)');

    console.log('\nFirst product, with a photo');
    await list.getByRole('button', { name: 'Add a product' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Speckled Mug');
    await page.getByLabel('Price').first().fill('34');
    await page.getByLabel('Starting stock').first().fill('8');
    await page.getByLabel('Status').selectOption('live');
    const dataUrl: string = await page.evaluate("(() => { var c = document.createElement('canvas'); c.width = 600; c.height = 600; var g = c.getContext('2d'); g.fillStyle = '#c9b8a6'; g.fillRect(0, 0, 600, 600); g.fillStyle = '#6b5a4c'; g.beginPath(); g.arc(300, 320, 150, 0, Math.PI * 2); g.fill(); return c.toDataURL('image/png'); })()");
    const dir = join(process.cwd(), 'tenant-checkout-out'); mkdirSync(dir, { recursive: true });
    const photo = join(dir, 'stranger-' + run + '.png'); writeFileSync(photo, Buffer.from(dataUrl.split(',')[1], 'base64'));
    await page.locator('input[type=file]').setInputFiles(photo);
    await page.getByRole('button', { name: /Remove photo 1/ }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(3000);
    const after = (await list.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check(/✓ Add your first product/.test(after), 'the product step ticks itself');

    console.log('\nConnect payments (the merchant\'s own step) and the resume path');
    await list.getByRole('button', { name: /Connect payments/ }).click();
    await page.waitForURL(/stripe\.com/, { timeout: 45_000 }).catch(() => {});
    check(/stripe\.com/.test(page.url()), 'Connect payments opens Stripe onboarding: ' + new URL(page.url()).host);
    await page.goto(APP + '/app', { waitUntil: 'load' });
    await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 30_000 });
    const resume = await page.getByRole('region', { name: 'Get your store ready' }).getByRole('button', { name: 'Continue with Stripe' }).isVisible().catch(() => false);
    check(resume, 'leaving Stripe half-way: the dashboard offers "Continue with Stripe" (no operator needed)');

    console.log('\nStore address and plan');
    await page.getByRole('button', { name: /^Settings$/ }).click();
    check(await page.getByRole('region', { name: 'Store address' }).isVisible().catch(() => false), 'Settings has the store address (self-serve)');
    await page.getByRole('button', { name: /^Plan & billing$/ }).click();
    check(await page.getByText(/Your plan: Free/).isVisible().catch(() => false), 'Plan & billing shows Free with the upgrade');
  } finally {
    await browser.close();
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
