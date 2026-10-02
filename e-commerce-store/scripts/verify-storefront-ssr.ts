/**
 * STOREFRONT FIRST SCREEN ON THE SERVER (lib/storefront-ssr.ts, flag OFF by
 * default; `?ssr=1` forces it per request). On the demo store and test4:
 *   - with ?ssr=1 the HTML itself carries the store's products (no
 *     "Loading" screen); without it, the old client-rendered shell;
 *   - the page hydrates without a React mismatch (no #418/#423/#425, no
 *     "Hydration failed"/"did not match" in the console);
 *   - the server-rendered page shows only its own store's products.
 * Prices, stock and checkout staying live: scripts/verify-no-stale-money.ts.
 *
 *   npx tsx scripts/verify-storefront-ssr.ts
 */
import { ROOT } from './proof-config';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const HYDRATION = /Minified React error #(418|423|425)|Hydration failed|did not match|hydrat/i;
const visibleText = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');

(async () => {
  const stores = ['demo', 'test4'];
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    const names: Record<string, string[]> = {};
    for (const s of stores) {
      const j: any = await (await fetch('https://' + s + '.' + ROOT + '/api/store')).json();
      names[s] = (j.allProducts || []).filter((p: any) => p.isActive === true && !p.isArchived && !p.isUpcoming).map((p: any) => String(p.name));
    }
    for (const s of stores) {
      const base = 'https://' + s + '.' + ROOT;
      const live = names[s];
      const other = names[stores.find((x) => x !== s)!].filter((n) => !live.includes(n));
      const j: any = await (await fetch(base + '/api/store')).json();
      const slug = (j.allProducts || []).find((p: any) => p.isActive === true && !p.isArchived && !p.isUpcoming)?.slug;
      console.log('\n' + s + '.' + ROOT + ' (' + live.length + ' live products)');
      for (const path of ['/', '/' + slug]) {
        const on = visibleText(await (await fetch(base + path + '?ssr=1')).text());
        const off = visibleText(await (await fetch(base + path + '?ssr=0')).text());
        const shown = live.filter((n) => on.includes(n));
        check(shown.length > 0, path + ' ?ssr=1: the HTML carries the store\'s products (' + shown.join(', ') + ')');
        check(!other.some((n) => on.includes(n)), path + ' ?ssr=1: none of the other store\'s products');
        // The product page's title carries its name either way, so the
        // "unchanged shell" check is the home page's only.
        if (path === '/') check(!live.some((n) => off.includes(n)), '/ ?ssr=0: unchanged client-rendered shell (no products in the HTML)');
        for (const q of ['?ssr=1', '?ssr=0']) {
          const page = await browser.newPage();
          const errs: string[] = [];
          page.on('console', (m) => { if (m.type() === 'error' && HYDRATION.test(m.text())) errs.push(m.text().slice(0, 140)); });
          page.on('pageerror', (e) => { if (HYDRATION.test(String(e.message))) errs.push(String(e.message).slice(0, 140)); });
          await page.goto(base + path + q, { waitUntil: 'load', timeout: 60_000 });
          await page.waitForTimeout(3000);
          check(errs.length === 0, path + q + ': hydrates without a mismatch' + (errs.length ? ' ' + JSON.stringify(errs) : ''));
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
