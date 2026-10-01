/**
 * PLATFORM IDENTITY, proven by renaming the platform.
 *
 *   1. Run a preview with a different name and domain, e.g.
 *        PLATFORM_NAME=Zephyrine PLATFORM_ROOT_DOMAIN=zephyrine-preview.test \
 *        SUPPORT_EMAIL=support@zephyrine-preview.test PLATFORM_MARKETING_ROOT=true next dev -p 3100
 *   2. PREVIEW_URL=http://localhost:3100 PLATFORM_NAME=Zephyrine \
 *        PLATFORM_ROOT_DOMAIN=zephyrine-preview.test npx tsx scripts/verify-platform-identity.ts
 *
 * Every platform surface (marketing, pricing/legal, sign-in portals, invite
 * acceptance, signup status) must show the new name and nothing of GOYUNIR
 * (the store, or the placeholder domain). The platform's system emails are
 * rendered here too, in record mode (never sent), and checked the same way.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
process.env.EMAIL_DRIVER = 'record';

const BASE = process.env.PREVIEW_URL || 'http://localhost:3100';
const NAME = process.env.PLATFORM_NAME || '';
const ROOT = process.env.PLATFORM_ROOT_DOMAIN || '';
if (!NAME || !ROOT || /goyunir/i.test(NAME + ROOT)) { console.error('Set PLATFORM_NAME and PLATFORM_ROOT_DOMAIN to the PREVIEW values (not GOYUNIR).'); process.exit(2); }
const FORBIDDEN = /goyunir|by our hands/i;
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };

function get(host: string, path: string): Promise<string> {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path, headers: { host, 'x-forwarded-proto': 'https', 'user-agent': 'identity-proof' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b));
    });
    req.on('error', reject); req.setTimeout(120_000, () => req.destroy(new Error('timeout ' + host + path))); req.end();
  });
}
const parts = (html: string) => {
  const head = (html.match(/<head>[\s\S]*?<\/head>/) || [''])[0];
  const meta = (head.match(/<title>[^<]*<\/title>|<meta[^>]+(name="description"|property="og:[a-z_:]+"|name="twitter:[a-z_:]+")[^>]*>/g) || []).join(' ');
  const text = html.replace(/<head>[\s\S]*?<\/head>/, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const scripts = (html.match(/<script[\s\S]*?<\/script>/g) || []).join(' ');
  return { meta, text, scripts, title: (head.match(/<title>([^<]*)<\/title>/) || [])[1] || '' };
};
const around = (s: string) => (s.match(/.{0,40}(goyunir|by our hands).{0,40}/i) || [''])[0];

(async () => {
  const surfaces: Array<[string, string, string]> = [
    ['marketing home', ROOT, '/'],
    ['terms', ROOT, '/platform/terms'],
    ['privacy', ROOT, '/platform/privacy'],
    ['signup status', ROOT, '/platform/signup-status?state=expired'],
    ['merchant sign-in', 'app.' + ROOT, '/app/login'],
    ['staff sign-in', 'admin.' + ROOT, '/admin/login'],
    ['sales sign-in', 'sales.' + ROOT, '/sales/login'],
    ['invite acceptance', 'app.' + ROOT, '/admin/accept-invite?token=x'],
  ];
  console.log('\nPages (preview at ' + BASE + ', platform "' + NAME + '" on ' + ROOT + ')');
  for (const [label, host, path] of surfaces) {
    const p = parts(await get(host, path));
    check(p.title.includes(NAME) && !FORBIDDEN.test(p.meta), label + ': title and link preview say "' + NAME + '" only (title "' + p.title + '")' + (FORBIDDEN.test(p.meta) ? ' — found: ' + around(p.meta) : ''));
    check(!FORBIDDEN.test(p.text), label + ': no GOYUNIR text on the page' + (FORBIDDEN.test(p.text) ? ' — found: "' + around(p.text) + '"' : ''));
    if (FORBIDDEN.test(p.scripts)) console.log('       note: page data (scripts) still carries "' + around(p.scripts).slice(0, 70) + '"');
  }

  console.log('\nPlatform emails (record mode: rendered, never sent)');
  process.env.PLATFORM_NAME = NAME;
  process.env.PLATFORM_ROOT_DOMAIN = ROOT;
  process.env.SUPPORT_EMAIL = process.env.PREVIEW_SUPPORT_EMAIL || 'support@' + ROOT;
  const email = await import('../lib/email');
  const { getDb } = await import('../lib/db/client');
  const { sentTo } = await import('./resend-readback');
  const run = Date.now().toString(36);
  const to = (k: string) => 'identity' + k + run + '@proof.invalid';
  const sends: Array<[string, string, () => Promise<unknown>]> = [
    ['sign-in code', to('code'), () => email.sendAdminVerificationEmail({ to: to('code'), code: '123456' })],
    ['platform staff invite', to('inv'), () => email.sendStaffInviteEmail({ to: to('inv'), role: 'sales', invitedBy: 'owner@' + ROOT, acceptUrl: 'https://admin.' + ROOT + '/admin/accept-invite?token=t', expiresInDays: 7 })],
    ['signup link', to('sv'), () => email.sendSignupVerifyEmail({ to: to('sv'), storeName: 'Kestrel Ceramics', url: 'https://' + ROOT + '/api/signup/merchant/complete?token=t', holdHours: 48 })],
    ['signup, existing account', to('se'), () => email.sendSignupExistingAccountEmail({ to: to('se'), signInUrl: 'https://app.' + ROOT + '/app/login' })],
  ];
  for (const [label, addr, send] of sends) {
    await send();
    const m = (await sentTo(getDb, addr, { waitMs: 10_000 }))[0];
    const display = String(m?.from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
    const body = String(m?.subject || '') + ' ' + String(m?.html || '').replace(/<[^>]+>/g, ' ');
    check(Boolean(m) && display === NAME, label + ': from "' + display + '"');
    check(Boolean(m) && !FORBIDDEN.test(body) && body.toLowerCase().includes(NAME.toLowerCase()), label + ': subject and body name "' + NAME + '", nothing of GOYUNIR' + (FORBIDDEN.test(body) ? ' — found: "' + around(body) + '"' : ''));
  }
  console.log('  (the sender ADDRESS is the verified sending domain, which DOMAIN-MIGRATION.md moves; only its display name is checked here)');

  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
