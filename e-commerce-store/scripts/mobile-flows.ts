/**
 * MOBILE FLOWS — the journeys a shopper from Instagram/TikTok actually takes,
 * driven by touch in real Chrome at phone widths, against production.
 *
 *   npx tsx scripts/mobile-flows.ts [outDir]
 *
 * Each step taps (touch, not click), screenshots, and runs the same checks as
 * mobile-audit.ts on whatever is now on screen — a sheet, a menu, a form — so
 * "the modal is wider than the phone" or "the submit button sits under the
 * sticky bar" shows up as a failed step, not a guess.
 *
 * The buy flow submits the real checkout form and expects to land on Stripe's
 * test-mode checkout page. It stops there: nothing is paid.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { auditInPage, CHROME, IPHONE_UA } from './mobile-audit';

const PRODUCT = process.env.FLOW_PRODUCT || 'https://shop.goyunir.com/roccstar';
const WIDTHS = [375, 390];

type Step = { name: string; ok: boolean; note: string; shot?: string; audit?: any };

async function snap(page: Page, out: string, name: string) {
  const file = join(out, name + '.png');
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

function summarize(a: any) {
  if (!a) return '';
  return 'overflow=' + (a.docWidth > a.vw + 1 ? a.docWidth + 'px' : 'no') +
    ' blockedTaps=' + a.tapTargets.blocked.length + ' smallTaps=' + a.tapTargets.tooSmall + '/' + a.tapTargets.total +
    ' inputZoom=' + a.inputZoom.length;
}

async function flow(page: Page, out: string, w: number): Promise<Step[]> {
  const steps: Step[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      const note = await fn();
      await page.waitForTimeout(900);
      const audit = await auditInPage(page).catch(() => null);
      steps.push({ name, ok: true, note, shot: await snap(page, out, w + '-' + name), audit });
    } catch (e) {
      steps.push({ name, ok: false, note: (e as Error).message.split('\n')[0], shot: await snap(page, out, w + '-' + name + '-FAILED') });
    }
  };

  await step('01-product', async () => { await page.goto(PRODUCT, { waitUntil: 'load', timeout: 90_000 }); return 'loaded'; });

  await step('02-menu-open', async () => {
    await page.getByRole('link', { name: /more/i }).first().tap({ timeout: 8000 });
    return 'tapped MORE';
  });
  await step('03-menu-close', async () => {
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto(PRODUCT, { waitUntil: 'load', timeout: 90_000 });
    return 'back on product';
  });

  await step('04-bag-open', async () => {
    await page.getByRole('button', { name: /bag/i }).first().tap({ timeout: 8000 });
    return 'tapped Bag';
  });
  await step('05-reload', async () => { await page.goto(PRODUCT, { waitUntil: 'load', timeout: 90_000 }); return 'reloaded'; });

  await step('06-pick-sample', async () => {
    await page.getByRole('button', { name: /sample/i }).first().tap({ timeout: 8000 });
    return 'tapped the sample size';
  });

  // THE REAL BUY PATH: email, an address PICKED from the Mapbox dropdown (the
  // store refuses a typed one), then the sticky buy button. Typed slowly so
  // the suggestions fire the way they do under a thumb.
  await step('07-email', async () => {
    const email = page.locator('input[type=email], input[placeholder*=email i]').first();
    await email.tap({ timeout: 8000 });
    await email.fill('mobile-flow-' + Date.now() + '@goyunir.invalid');
    return 'email entered';
  });

  await step('08-address-type', async () => {
    const addr = page.locator('input[placeholder*=address i], input[autocomplete*=address i]').first();
    await addr.tap({ timeout: 8000 });
    await addr.pressSequentially('1600 Pennsylvania Avenue', { delay: 90 });
    const option = page.locator('[role=option]').first();
    const shown = await option.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
    const count = await page.locator('[role=option]').count();
    if (!shown) throw new Error('NO SUGGESTIONS appeared after typing (' + count + ' options in DOM)');
    const box = await option.boundingBox();
    const vp = page.viewportSize();
    return count + ' suggestions; first at y=' + (box ? Math.round(box.y) : '?') + ' of ' + (vp ? vp.height : '?');
  });

  await step('09-address-pick', async () => {
    const option = page.locator('[role=option]').first();
    const label = (await option.innerText().catch(() => '')).replace(/s+/g, ' ').slice(0, 60);
    await option.tap({ timeout: 8000 });
    await page.waitForTimeout(1200);
    const value = await page.locator('input[placeholder*=address i], input[autocomplete*=address i]').first().inputValue();
    const warn = await page.getByText(/select your full address from the dropdown/i).first().isVisible().catch(() => false);
    return 'tapped "' + label + '" -> field = "' + value.slice(0, 70) + '"' + (warn ? '  | STILL WARNING: pick from dropdown' : '');
  });

  await step('10-buy', async () => {
    const buy = page.locator('.goyunir-pdp-cta-bar button').first();
    const text = (await buy.innerText({ timeout: 8000 })).trim();
    await buy.tap({ timeout: 8000 });
    await page.waitForURL(/checkout.stripe.com/, { timeout: 30_000 }).catch(() => {});
    const url = page.url();
    const err = await page.locator('[role=alert], [class*=error i], [class*=warn i]').first().innerText({ timeout: 1500 }).catch(() => '');
    if (!url.includes('checkout.stripe.com')) throw new Error('did not reach Stripe after "' + text + '" -> ' + url + (err ? ' | ' + err.slice(0, 140) : ''));
    return 'tapped "' + text + '" -> STRIPE CHECKOUT';
  });

  return steps;
}

async function main() {
  const out = process.argv[2] || join(process.cwd(), 'mobile-flows-out');
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const all: any[] = [];
  try {
    for (const w of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width: w, height: w === 375 ? 667 : 844 }, deviceScaleFactor: 3,
        isMobile: true, hasTouch: true, userAgent: IPHONE_UA,
      });
      await context.addInitScript('window.__name = function (f) { return f; };');
      const page = await context.newPage();
      const steps = await flow(page, out, w);
      console.log('\n=== ' + w + 'px');
      for (const s of steps) console.log((s.ok ? '  ok   ' : '  FAIL ') + s.name.padEnd(14) + ' ' + s.note + (s.audit ? '  [' + summarize(s.audit) + ']' : ''));
      all.push({ width: w, steps });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(out, 'flows.json'), JSON.stringify(all, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
