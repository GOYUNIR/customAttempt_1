/**
 * MOBILE AUDIT — real Chrome at real phone widths, against production.
 *
 *   npx tsx scripts/mobile-audit.ts [outDir]
 *
 * Most traffic arrives from Instagram/TikTok on a phone, often at the second a
 * drop goes live, so mobile is checked with a browser engine rather than a
 * resized desktop window: touch, a mobile user agent, a 3x screen, and — for
 * load timing — a throttled mobile network and CPU.
 *
 * Per page and width it reports what a shopper actually hits:
 *   overflow     the page is wider than the screen (sideways scrolling)
 *   tapTargets   buttons/links smaller than 44x44 CSS px (Apple's minimum)
 *   inputZoom    form fields under 16px text — iOS zooms the whole page on tap
 *   tinyText     readable text under 12px
 *   overlays     fixed elements covering more than a quarter of the screen
 *   timing       TTFB / FCP / LCP / bytes on "Slow 4G" + 4x CPU (390px only)
 * and saves a screenshot per page and width for a human look.
 *
 * Uses the installed Chrome (playwright-core; no browser download).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export const VIEWPORTS = [
  { name: '375', width: 375, height: 667 },
  { name: '390', width: 390, height: 844 },
  { name: '414', width: 414, height: 896 },
];

const PAGES = (process.env.AUDIT_PAGES || [
  'store-home=https://shop.goyunir.com/',
  'product=https://shop.goyunir.com/roccstar',
  'product-2=https://shop.goyunir.com/black-solstice',
  'marketing=https://goyunir.com/',
].join(',')).split(',').map((s) => { const [id, url] = s.split('='); return { id, url }; });

export async function auditInPage(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const label = (el: Element) => {
      const h = el as HTMLElement;
      const text = (h.innerText || h.getAttribute('aria-label') || h.getAttribute('placeholder') || h.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const cls = typeof h.className === 'string' ? h.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
      return el.tagName.toLowerCase() + (h.id ? '#' + h.id : '') + (cls ? '.' + cls : '') + (text ? ' "' + text + '"' : '');
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };

    const docWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const overflowers: string[] = [];
    if (docWidth > vw + 1) {
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 && r.width > 0 && visible(el)) {
          // Report the outermost offender, not every descendant of it.
          const parent = el.parentElement;
          const pr = parent ? parent.getBoundingClientRect() : null;
          if (!pr || pr.right <= vw + 1) overflowers.push(label(el) + ' right=' + Math.round(r.right));
        }
        if (overflowers.length >= 8) break;
      }
    }

    const interactive = Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [onclick], summary'))
      .filter(visible);
    const small: string[] = [];
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) small.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }

    // USABLE, not just visible: a tap at the element's centre must land on
    // the element (or inside it). Anything else — an overlay, a sticky bar,
    // a transparent layer — means the tap goes somewhere else.
    const blocked: string[] = [];
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue; // only what is on screen now
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        blocked.push(label(el) + ' -> tap lands on ' + label(hit));
      }
    }

    const zoomers: string[] = [];
    for (const el of Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')).filter(visible)) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) zoomers.push(label(el) + ' ' + fs + 'px');
    }

    let tiny = 0;
    const tinySamples: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '').trim();
      if (t.length < 3 || !n.parentElement || !visible(n.parentElement)) continue;
      const fs = parseFloat(getComputedStyle(n.parentElement).fontSize);
      if (fs < 12) { tiny += 1; if (tinySamples.length < 5) tinySamples.push(fs + 'px "' + t.slice(0, 30) + '"'); }
    }

    const overlays: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (area > 0.25 * vw * vh) overlays.push(label(el) + ' covers ' + Math.round((100 * area) / (vw * vh)) + '%');
    }

    const meta = document.querySelector('meta[name=viewport]')?.getAttribute('content') || '(none)';
    return {
      viewportMeta: meta,
      docWidth, vw,
      overflow: overflowers,
      tapTargets: { total: interactive.length, tooSmall: small.length, samples: small.slice(0, 12), blocked },
      inputZoom: zoomers,
      tinyText: { count: tiny, samples: tinySamples },
      overlays,
    };
  });
}

async function timingInPage(page: Page) {
  return page.evaluate(async () => {
    const lcp = await new Promise<number>((resolve) => {
      let v = 0;
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) v = Math.max(v, e.startTime); })
          .observe({ type: 'largest-contentful-paint', buffered: true });
      } catch { /* not supported */ }
      setTimeout(() => resolve(v), 800);
    });
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const bytes = res.reduce((s, r) => s + (r.transferSize || 0), 0) + (nav?.transferSize || 0);
    const jsBytes = res.filter((r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name)).reduce((s, r) => s + (r.transferSize || 0), 0);
    return {
      ttfbMs: Math.round(nav ? nav.responseStart - nav.requestStart : 0),
      fcpMs: Math.round(fcp),
      lcpMs: Math.round(lcp),
      loadMs: Math.round(nav ? nav.loadEventEnd : 0),
      requests: res.length + 1,
      transferKB: Math.round(bytes / 1024),
      jsKB: Math.round(jsBytes / 1024),
    };
  });
}

async function main() {
  const outDir = process.argv[2] || join(process.cwd(), 'mobile-audit-out');
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const report: any[] = [];
  try {
    for (const vp of VIEWPORTS) {
      for (const pg of PAGES) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 3,
          isMobile: true, hasTouch: true, userAgent: IPHONE_UA,
        });
        // tsx/esbuild wraps named functions in a __name() helper; functions
        // passed to page.evaluate run in the page, where it does not exist.
        await context.addInitScript('window.__name = function (f) { return f; };');
        const page = await context.newPage();
        const throttle = vp.name === '390';
        if (throttle) {
          const cdp = await context.newCDPSession(page);
          // Lighthouse's "Slow 4G" and its 4x CPU slowdown for mid-range phones.
          await cdp.send('Network.enable');
          await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        }
        let status = 0;
        let error: string | null = null;
        try {
          const resp = await page.goto(pg.url, { waitUntil: 'load', timeout: 90_000 });
          status = resp?.status() || 0;
          await page.waitForTimeout(1500);
        } catch (e) {
          error = (e as Error).message.split('\n')[0];
        }
        const audit = error ? null : await auditInPage(page);
        const timing = error || !throttle ? null : await timingInPage(page);
        const shot = join(outDir, pg.id + '-' + vp.name + '.png');
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        report.push({ page: pg.id, url: pg.url, width: vp.name, status, error, audit, timing, screenshot: shot });
        const a = audit;
        console.log(
          (pg.id + ' @' + vp.name).padEnd(20) + ' ' + String(status).padEnd(4) +
          (error ? ' ERROR ' + error :
            ' overflow=' + (a!.docWidth > a!.vw + 1 ? a!.docWidth + 'px' : 'no') +
            ' smallTaps=' + a!.tapTargets.tooSmall + '/' + a!.tapTargets.total +
            ' blockedTaps=' + a!.tapTargets.blocked.length + ' inputZoom=' + a!.inputZoom.length + ' tinyText=' + a!.tinyText.count + ' overlays=' + a!.overlays.length +
            (timing ? '  | TTFB ' + timing.ttfbMs + ' FCP ' + timing.fcpMs + ' LCP ' + timing.lcpMs + ' load ' + timing.loadMs + 'ms, ' + timing.transferKB + 'KB (' + timing.jsKB + 'KB JS)' : '')),
        );
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\nreport: ' + join(outDir, 'report.json'));
}

if (/mobile-audit.ts$/.test(process.argv[1] || '')) main().catch((e) => { console.error(e); process.exit(1); });

export { CHROME, IPHONE_UA };
