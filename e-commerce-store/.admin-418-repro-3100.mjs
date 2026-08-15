import { chromium } from 'playwright-core';
import fs from 'node:fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const user = env.ADMIN_BASIC_AUTH_USERNAME || 'admin';
const pass = env.ADMIN_BASIC_AUTH_PASSWORD || '';
const basic = Buffer.from(`${user}:${pass}`).toString('base64');

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.setExtraHTTPHeaders({ Authorization: `Basic ${basic}` });
const page = await context.newPage();

const errors = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error' || /#418|hydrat|server rendered|didn't match/i.test(text)) {
    errors.push(`[${msg.type()}] ${text}`);
  }
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

console.log('>> Navigating to /admin...');
await page.goto('http://localhost:3100/admin', { waitUntil: 'domcontentloaded', timeout: 40000 });
await page.waitForTimeout(3000);

// Click "Send me a code" if present (waits out any throttle message).
for (let attempt = 0; attempt < 4; attempt++) {
  const sendBtn = page.getByRole('button', { name: /send (me )?a code/i });
  if (await sendBtn.count()) {
    await sendBtn.first().click().catch(() => {});
    await page.waitForTimeout(3000);
  }
  const devCode = await page.evaluate(() => {
    const m = document.body.innerText.match(/Dev mode code:\s*(\d{6})/);
    return m ? m[1] : null;
  });
  if (devCode) {
    console.log('>> Dev code:', devCode);
    await page.locator('input').first().fill(devCode);
    await page.getByRole('button', { name: /verify & unlock/i }).first().click().catch(() => {});
    break;
  }
  await page.waitForTimeout(15000);
}

await page.waitForTimeout(10000);

const bodyText = (await page.evaluate(() => document.body.innerText.slice(0, 400))).replace(/\s+/g, ' ').trim();
console.log('==== BODY (first 400 chars) ====');
console.log(bodyText);

console.log('==== ERRORS ====');
console.log(errors.length ? errors.join('\n') : '(none)');

await browser.close();
