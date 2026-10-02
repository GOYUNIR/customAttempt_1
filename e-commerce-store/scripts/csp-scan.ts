/**
 * CSP SCAN: load the pages people actually use in a real browser and collect
 * every Content-Security-Policy violation (report-only violations fire the
 * same `securitypolicyviolation` event an enforced policy would), grouped by
 * directive and blocked origin. The evidence for what is safe to enforce.
 *
 *   npx tsx scripts/csp-scan.ts [--json out.json]
 *   exits 1 if the ENFORCED policy blocked anything (in the release gate)
 *
 * Signed in as test4's owner for the dashboard (every tab clicked).
 */
import { ROOT } from './proof-config';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
import { chromium } from 'playwright-core';
import { CHROME } from './mobile-audit';

const A = '13591c9e-82e4-4c23-8d94-249cef6fa775';
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : ''; };

(async () => {
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { createKvClient } = await import('../lib/server-config');
  const owner = ((await getDb().select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
  const token = (await issueAdminDevice(createKvClient() as any, owner, false, deviceMetaFor((await readStaffIdentity(owner))!), 900)).token;
  const demo = await (await fetch('https://demo.' + ROOT + '/api/store')).json() as any;
  const demoSlug = (demo.allProducts || [])[0]?.slug || '';

  const pages: { url: string; signedIn?: boolean; clickTabs?: boolean }[] = [
    { url: 'https://' + ROOT + '/' },
    { url: 'https://' + ROOT + '/terms' },
    { url: 'https://' + ROOT + '/privacy' },
    { url: 'https://demo.' + ROOT + '/' },
    { url: 'https://demo.' + ROOT + '/' + demoSlug },
    { url: 'https://demo.' + ROOT + '/catalog' },
    { url: 'https://demo.' + ROOT + '/account' },
    { url: 'https://demo.' + ROOT + '/auth/login' },
    { url: 'https://test4.' + ROOT + '/' },
    { url: 'https://test4.' + ROOT + '/connect-test-item' },
    { url: 'https://app.' + ROOT + '/app', signedIn: true, clickTabs: true },
    { url: 'https://admin.' + ROOT + '/admin' },
    { url: 'https://sales.' + ROOT + '/sales' },
  ];

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const seen: any[] = [];
  try {
    for (const p of pages) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      if (p.signedIn) await ctx.addCookies([{ name: 'goyunir_admin_device', value: token, domain: new URL(p.url).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      await page.exposeFunction('__cspReport', (v: any) => seen.push({ page: p.url, ...v }));
      await page.addInitScript(`document.addEventListener('securitypolicyviolation', function (e) { window.__cspReport({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition, source: e.sourceFile, sample: (e.sample || '').slice(0, 60) }); });`);
      const before = seen.length;
      try {
        await page.goto(p.url, { waitUntil: 'load', timeout: 60_000 });
        await page.waitForTimeout(3000);
        if (p.clickTabs) {
          const tabs = await page.locator('nav button, [role="tab"]').all();
          for (const t of tabs.slice(0, 30)) { try { if (await t.isVisible()) { await t.click({ timeout: 3000 }); await page.waitForTimeout(1500); } } catch { /* a tab that cannot be clicked */ } }
        }
      } catch (e: any) { console.log('  (load problem on ' + p.url + ': ' + String(e.message).slice(0, 80) + ')'); }
      console.log((seen.length - before ? String(seen.length - before).padStart(3) + ' violations  ' : '  0 violations  ') + p.url);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const groups = new Map<string, { n: number; pages: Set<string>; sample: string }>();
  for (const v of seen) {
    let origin = v.blocked; try { origin = new URL(v.blocked).origin; } catch { /* 'inline', 'eval', 'data' */ }
    const k = v.directive + '  ' + origin;
    const g = groups.get(k) || { n: 0, pages: new Set<string>(), sample: v.sample || v.source || '' };
    g.n++; g.pages.add(new URL(v.page).hostname + new URL(v.page).pathname); groups.set(k, g);
  }
  console.log('\nBy directive and blocked source:');
  for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) console.log('  ' + String(g.n).padStart(4) + '  ' + k + '   on ' + [...g.pages].slice(0, 4).join(', ') + (g.sample ? '   e.g. ' + JSON.stringify(g.sample) : ''));
  if (!groups.size) console.log('  none');
  if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(seen, null, 2));
  // Report-only findings are evidence; an ENFORCED violation is something the
  // policy actually broke on a real page.
  const enforced = seen.filter((v) => v.disposition === 'enforce');
  console.log('\n' + (enforced.length ? enforced.length + ' ENFORCED violation(s): the policy blocked something real' : 'ALL PASS (no enforced violations; ' + seen.length + ' report-only)'));
  process.exit(enforced.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
