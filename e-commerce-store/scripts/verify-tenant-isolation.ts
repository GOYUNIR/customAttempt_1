/**
 * TENANT ISOLATION CHECK (TENANCY.md). npx tsx scripts/verify-tenant-isolation.ts
 *
 * Loads real pages on BOTH stores in Chrome and records every response that
 * mentions the OTHER store's products (by name or slug), plus what is visible
 * on the page. Written after the owner spotted the default store's products
 * on test4's catalog page (/api/catalog/status, 2026-09-26): a leak through
 * a route nobody had listed. Exit 1 on any cross-store mention.
 */
import { chromium } from 'playwright-core';
import { CHROME, IPHONE_UA } from './mobile-audit';

const CHECKS: Array<{ store: string; pages: string[]; foreign: RegExp }> = [
  { store: 'test4', pages: ['https://test4.goyunir.com/', 'https://test4.goyunir.com/catalog', 'https://test4.goyunir.com/connect-test-item', 'https://test4.goyunir.com/roccstar'], foreign: /black[- ]solstice|the cause of commitment issues|boosy campfire/i },
  { store: 'shop', pages: ['https://shop.goyunir.com/', 'https://shop.goyunir.com/catalog', 'https://shop.goyunir.com/roccstar'], foreign: /connect[- ]test[- ]item|prod_tenant_test_1/i },
];

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  let leaks = 0;
  for (const c of CHECKS) {
    for (const url of c.pages) {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
      const page = await ctx.newPage();
      const hits: string[] = [];
      page.on('response', async (r) => {
        try {
          if (!/json|html|javascript|text/.test(r.headers()['content-type'] || '')) return;
          const m = (await r.text()).match(new RegExp(c.foreign.source, 'gi'));
          if (m) hits.push(r.status() + ' ' + r.url().slice(0, 100) + ' x' + m.length);
        } catch {}
      });
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForTimeout(3500);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);
      const visible = ((await page.evaluate(() => document.body.innerText)).match(new RegExp(c.foreign.source, 'gi')) || []).length;
      const bad = hits.length + visible;
      leaks += bad;
      console.log((bad ? 'LEAK ' : 'ok   ') + c.store.padEnd(6) + url + '  visible=' + visible + (hits.length ? '  responses: ' + hits.join(' | ') : ''));
      await ctx.close();
    }
  }
  await b.close();
  console.log(leaks === 0 ? '\nNO CROSS-STORE DATA' : '\n' + leaks + ' CROSS-STORE MENTION(S)');
  process.exit(leaks === 0 ? 0 : 1);
})();
