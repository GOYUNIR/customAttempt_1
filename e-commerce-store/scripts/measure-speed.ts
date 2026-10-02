/**
 * SPEED: TTFB and LCP on a throttled phone (Lighthouse's mobile profile:
 * 150ms RTT, 1.6 Mbps down, 750 kbps up, 4x CPU slowdown), cold cache, for
 * the marketing home, a store home, a product page and the merchant
 * dashboard. Median of RUNS loads each; also prints each page's
 * cache-control and cf-cache-status.
 *
 *   npx tsx scripts/measure-speed.ts [--runs 5] [--json out.json] [--ab]
 *   --ab alternates loads with and without <link rel="preload" as="image"> tags (stripped in the browser)
 */
import { ROOT } from './proof-config';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };
const RUNS = Number(arg('--runs') || 5);
const AB = process.argv.includes('--ab');
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4: the dashboard is measured as its owner
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const owner = ((await getDb().select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const token = (await issueAdminDevice(createKvClient() as any, owner, false, deviceMetaFor((await readStaffIdentity(owner))!), 1800)).token;

  const store = await (await fetch('https://demo.' + ROOT + '/api/store')).json() as any;
  const slug = (store.products || []).find((p: any) => p.slug && p.isActive !== false)?.slug;
  const pages: { name: string; url: string; cookie?: boolean }[] = [
    { name: 'marketing home', url: 'https://' + ROOT + '/' },
    { name: 'store home', url: 'https://demo.' + ROOT + '/' },
    { name: 'product page', url: 'https://demo.' + ROOT + '/' + slug },
    { name: 'dashboard', url: 'https://app.' + ROOT + '/app', cookie: true },
  ];

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const out: any[] = [];
  try {
    for (const p of pages) {
      const ttfb: number[] = [], lcp: number[] = [];
      const ab = { with: [] as any[], without: [] as any[] };
      let headers: Record<string, string> = {};
      for (let i = 0; i < RUNS; i++) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
        if (p.cookie) await ctx.addCookies([{ name: 'goyunir_admin_device', value: token, domain: 'app.' + ROOT, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.addInitScript(`window.__lcp = 0; new PerformanceObserver(function (l) { var e = l.getEntries(); window.__lcp = e[e.length - 1].startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });`);
        // --ab: every other load has its image preloads
        // stripped from the HTML. Both variants fetch the document the same way
        // (route.fetch is not throttled), so only the tags differ between them.
        const strip = AB && i % 2 === 1;
        if (AB) await page.route(p.url, async (route) => {
          const r = await route.fetch();
          const html = await r.text();
          await route.fulfill({ response: r, body: strip ? html.replace(/<link rel="preload"[^>]*as="image"[^>]*>/g, '') : html });
        });
        const resp = await page.goto(p.url, { waitUntil: 'load', timeout: 90_000 });
        await page.waitForTimeout(2500);
        const m: any = await page.evaluate(`(() => { var n = performance.getEntriesByType('navigation')[0]; var s = performance.getEntriesByType('resource').filter(function (r) { return /\\/api\\/store/.test(r.name); })[0]; return { ttfb: n.responseStart, lcp: window.__lcp, data: s ? s.startTime : 0 }; })()`);
        (strip ? ab.without : ab.with).push({ afterTtfb: Math.round(m.lcp - m.ttfb), dataAfterTtfb: m.data ? Math.round(m.data - m.ttfb) : null });
        ttfb.push(Math.round(m.ttfb)); lcp.push(Math.round(m.lcp));
        if (i === 0 && resp) { const h = resp.headers(); headers = { status: String(resp.status()), 'cache-control': h['cache-control'] || '', 'cf-cache-status': h['cf-cache-status'] || '' }; }
        await ctx.close();
      }
      if (AB) for (const [k, xs] of Object.entries(ab)) if (xs.length) console.log('   ' + (k === 'with' ? 'with hints   ' : 'hints removed') + '  LCP after first byte ' + median(xs.map((x) => x.afterTtfb)) + 'ms  data request starts ' + median(xs.map((x) => x.dataAfterTtfb ?? -1)) + 'ms after first byte  (n=' + xs.length + ')');
      const row = { page: p.name, url: p.url, ttfbMs: median(ttfb), lcpMs: median(lcp), ttfbRuns: ttfb, lcpRuns: lcp, ab, ...headers };
      out.push(row);
      console.log(p.name.padEnd(15) + ' TTFB ' + String(row.ttfbMs).padStart(5) + 'ms  LCP ' + String(row.lcpMs).padStart(5) + 'ms   runs ttfb ' + ttfb.join('/') + ' lcp ' + lcp.join('/') + '   ' + headers.status + ' cc="' + headers['cache-control'] + '" cf=' + (headers['cf-cache-status'] || '-'));
    }
  } finally {
    await browser.close();
  }
  if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify({ at: new Date().toISOString(), runs: RUNS, profile: '150ms RTT, 1.6Mbps/750kbps, 4x CPU, 390x844', pages: out }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
