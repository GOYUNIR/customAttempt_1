import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.setExtraHTTPHeaders({ Authorization: 'Basic Z295dW5pckBnbWFpbC5jb206Z295dW5pci1hZG1pbi1kZXY=' });
const page = await context.newPage();
const errors = [];
page.on('response', (res) => { if (res.status() === 404 || res.status() >= 500) errors.push('[http' + res.status() + '] ' + res.url()); });
await page.goto('http://localhost:3100/admin', { waitUntil: 'domcontentloaded', timeout: 40000 });
await page.waitForTimeout(3000);
for (let attempt = 0; attempt < 4; attempt++) {
  const sendBtn = page.getByRole('button', { name: /send (me )?a code/i });
  if (await sendBtn.count()) { await sendBtn.first().click().catch(() => {}); await page.waitForTimeout(3000); }
  const devCode = await page.evaluate(() => { const m = document.body.innerText.match(/Dev mode code:\s*(\d{6})/); return m ? m[1] : null; });
  if (devCode) {
    await page.locator('input').first().fill(devCode);
    await page.getByRole('button', { name: /verify & unlock/i }).first().click().catch(() => {});
    break;
  }
  await page.waitForTimeout(15000);
}
await page.waitForTimeout(5000);
const result = await page.evaluate(async () => {
  const fd = new FormData();
  fd.append('productId', 'nonexistent');
  fd.append('password', 'wrong-password');
  fd.append('file', new File(['x'.repeat(100)], 'tiny.txt', { type: 'text/plain' }));
  const res = await fetch('/api/admin/upload', { method: 'POST', body: fd, credentials: 'include' });
  return { status: res.status, body: await res.text() };
});
console.log('UPLOAD RESULT:', JSON.stringify(result));
console.log('HTTP ERRORS:', errors.length ? errors.join('\n') : '(none)');
await browser.close();
