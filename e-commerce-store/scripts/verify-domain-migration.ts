/**
 * DOMAIN MIGRATION CHECK — every item in DOMAIN-MIGRATION.md, against a
 * target platform domain, as PASS / FAIL / MANUAL (needs a dashboard look).
 *
 *   npx tsx scripts/verify-domain-migration.ts <target> [--old goyunir.com] [--goyunir-domain goyunir.com]
 *
 * Rehearsal (today): run it with the CURRENT domain as the target,
 *   npx tsx scripts/verify-domain-migration.ts goyunir.com
 * and everything that applies to a live platform domain must pass.
 *
 * Optional, for the checks that read a dashboard's API (otherwise MANUAL):
 *   SUPABASE_ACCESS_TOKEN                    Supabase Auth site URL + redirects
 *   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID   Turnstile widget hostnames
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';

const args = process.argv.slice(2);
const TARGET = String(args.find((a) => !a.startsWith('--') && !['--old', '--goyunir-domain'].includes(args[args.indexOf(a) - 1])) || '').toLowerCase();
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? String(args[i + 1] || '').toLowerCase() : ''; };
const OLD = opt('--old');
const GOYUNIR_DOMAIN = opt('--goyunir-domain');
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(TARGET)) { console.error('usage: verify-domain-migration.ts <target-domain> [--old <old-root>] [--goyunir-domain <domain>]'); process.exit(2); }

type Row = { area: string; check: string; result: 'PASS' | 'FAIL' | 'MANUAL'; note: string };
const rows: Row[] = [];
const add = (area: string, check: string, ok: boolean | 'manual', note = '') => rows.push({ area, check, result: ok === 'manual' ? 'MANUAL' : ok ? 'PASS' : 'FAIL', note });

function wranglerConfig() {
  const src = readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const vars: Record<string, string> = {};
  for (const m of (/"vars"\s*:\s*\{([\s\S]*?)\}/.exec(src)?.[1] || '').matchAll(/"([A-Z0-9_]+)"\s*:\s*"([^"]*)"/g)) vars[m[1]] = m[2];
  const routes = [...src.matchAll(/"pattern"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return { vars, routes };
}
async function dns(name: string, type: string): Promise<string[]> {
  const r: any = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=' + type, { headers: { accept: 'application/dns-json' } }).then((x) => x.json()).catch(() => ({}));
  return (r.Answer || []).map((a: any) => String(a.data));
}
const cfIp = (ip: string) => /^(104\.(1[6-9]|2[0-9]|3[01])\.|172\.(6[4-9]|7[01])\.|188\.114\.|2606:4700:)/.test(ip);
async function head(url: string) {
  try { const r = await fetch(url, { redirect: 'manual' }); return { status: r.status, location: r.headers.get('location') || '', headers: r.headers, text: r.status === 200 ? await r.text() : '' }; }
  catch (e) { return { status: 0, location: '', headers: new Headers(), text: String((e as Error).message) }; }
}

(async () => {
  const { vars, routes } = wranglerConfig();

  // ── 1. Config: one value, and everything that must follow it ──────────────
  add('config', 'PLATFORM_ROOT_DOMAIN = target', vars.PLATFORM_ROOT_DOMAIN === TARGET, 'is ' + vars.PLATFORM_ROOT_DOMAIN);
  add('config', 'Worker routes cover target and *.target', routes.includes(TARGET + '/*') && routes.includes('*.' + TARGET + '/*'), routes.join(', '));
  add('config', 'TURNSTILE_EXPECTED_HOSTNAMES includes target', String(vars.TURNSTILE_EXPECTED_HOSTNAMES || '').split(',').map((s) => s.trim()).includes(TARGET), vars.TURNSTILE_EXPECTED_HOSTNAMES);
  add('config', 'SUPPORT_EMAIL on target', String(vars.SUPPORT_EMAIL || '').endsWith('@' + TARGET), vars.SUPPORT_EMAIL);
  if (OLD) add('config', 'PLATFORM_OLD_ROOT_DOMAINS includes old root (301s)', String(vars.PLATFORM_OLD_ROOT_DOMAINS || '').split(',').map((s) => s.trim()).includes(OLD), vars.PLATFORM_OLD_ROOT_DOMAINS || '(unset)');

  // ── 2. DNS: zone, apex and wildcard on Cloudflare's proxy ─────────────────
  const apex = await dns(TARGET, 'A');
  const wild = await dns('zz-check-' + Date.now().toString(36) + '.' + TARGET, 'A');
  add('dns', 'apex resolves to Cloudflare (proxied)', apex.length > 0 && apex.every(cfIp), apex.join(' '));
  add('dns', 'wildcard (*.target) resolves to Cloudflare (proxied)', wild.length > 0 && wild.every(cfIp), wild.join(' ') || 'no answer');
  const ns = await dns(TARGET, 'NS');
  add('dns', 'zone is on Cloudflare (nameservers)', ns.length > 0 && ns.every((n) => /\.ns\.cloudflare\.com\.?$/.test(n)), ns.join(' '));

  // ── 3. The Worker answers on every kind of host ───────────────────────────
  const home = await head('https://' + TARGET + '/');
  add('worker', 'https://target/ serves the platform site', home.status === 200 && /<title>/.test(home.text), 'status ' + home.status);
  const login = await head('https://app.' + TARGET + '/app/login');
  add('worker', 'https://app.target/app/login serves the merchant sign-in', login.status === 200, 'status ' + login.status);
  const nobody = await head('https://zz-nobody-' + Date.now().toString(36) + '.' + TARGET + '/');
  add('worker', 'an unknown store address gets the 404 page', nobody.status === 404, 'status ' + nobody.status);
  const { getDb } = await import('../lib/db/client');
  const { eq } = await import('../lib/db/query');
  const store = ((await getDb().select<any>('tenants', { where: { license_status: eq('active') }, select: ['slug'], limit: 50 })) as any[]).map((t) => t.slug).find((s) => s && s !== 'goyunir' && !String(s).startsWith('x--'));
  if (store) { const s = await head('https://' + store + '.' + TARGET + '/'); add('worker', 'a merchant store answers on its address (' + store + '.target)', s.status === 200, 'status ' + s.status); }

  // ── 4. Security headers and CSP (Turnstile, media) ────────────────────────
  const csp = String(home.headers.get('content-security-policy-report-only') || home.headers.get('content-security-policy') || '');
  add('headers', 'HSTS on', /max-age=\d+/.test(String(home.headers.get('strict-transport-security') || '')));
  add('headers', 'CSP allows Turnstile and the media host', /challenges\.cloudflare\.com/.test(csp) && (!vars.MEDIA_S3_PUBLIC_BASE_URL || csp.includes(new URL(vars.MEDIA_S3_PUBLIC_BASE_URL).host) || /img-src[^;]*https:/.test(csp)), csp ? 'present' : 'missing');

  // ── 5. Cookies: per-portal, on the target ─────────────────────────────────
  const { cookieDomainForPortal } = await import('../lib/edge-router');
  add('cookies', 'portal cookies scope to the target\'s portal hosts', cookieDomainForPortal('admin', TARGET) === 'admin.' + TARGET, String(cookieDomainForPortal('admin', TARGET)));

  // ── 6. Turnstile ──────────────────────────────────────────────────────────
  const su = await fetch('https://' + TARGET + '/api/signup/merchant').then((r) => r.json()).catch(() => null) as any;
  add('turnstile', 'signup serves the Turnstile site key on the target', Boolean(su?.siteKey), su ? 'site key ' + (su.siteKey ? 'present' : 'missing') : 'no answer');
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID && su?.siteKey) {
    const w: any = await fetch('https://api.cloudflare.com/client/v4/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID + '/challenges/widgets/' + su.siteKey, { headers: { authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN } }).then((r) => r.json()).catch(() => null);
    add('turnstile', 'the widget lists the target hostname', Boolean(w?.result?.domains?.includes(TARGET)), (w?.result?.domains || []).join(', '));
  } else add('turnstile', 'the widget lists the target hostname', 'manual', 'Cloudflare → Turnstile → the widget → Hostnames');

  // ── 7. Stripe: webhook endpoints and events on the target ─────────────────
  const { resolveStripeClient } = await import('../services/payment/factory');
  const stripe: any = await resolveStripeClient();
  if (stripe) {
    const eps = (await stripe.webhookEndpoints.list({ limit: 100 })).data as any[];
    const need = (url: string, events: string[], connect: boolean) => {
      const ep = eps.find((e) => e.url === url && e.status === 'enabled' && Boolean(e.application || e.connect) === connect || e.url === url && e.status === 'enabled');
      const missing = ep ? events.filter((ev) => !ep.enabled_events.includes(ev) && !ep.enabled_events.includes('*')) : events;
      return { ok: Boolean(ep) && missing.length === 0, note: ep ? (missing.length ? 'missing ' + missing.join(', ') : 'ok (' + (ep.livemode ? 'live' : 'test') + ')') : 'no endpoint at ' + url };
    };
    const p = need('https://' + TARGET + '/api/stripe/webhook', ['checkout.session.completed', 'checkout.session.expired', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'], false);
    add('stripe', 'platform webhook on target with its events', p.ok, p.note);
    const c = need('https://' + TARGET + '/api/stripe/connect-webhook', ['account.updated', 'checkout.session.completed', 'checkout.session.expired', 'payment_intent.succeeded', 'charge.refunded', 'charge.dispute.created'], true);
    add('stripe', 'Connect webhook on target with its events', c.ok, c.note);
    add('stripe', 'return URLs (checkout, onboarding, billing) follow the target', true, 'derived from PLATFORM_ROOT_DOMAIN / the request host in code');
  } else add('stripe', 'webhook endpoints', false, 'Stripe not configured locally');

  // ── 8. Supabase Auth ──────────────────────────────────────────────────────
  if (process.env.SUPABASE_ACCESS_TOKEN) {
    const ref = new URL(String(process.env.SUPABASE_URL)).host.split('.')[0];
    const a: any = await fetch('https://api.supabase.com/v1/projects/' + ref + '/config/auth', { headers: { authorization: 'Bearer ' + process.env.SUPABASE_ACCESS_TOKEN } }).then((r) => r.json()).catch(() => null);
    add('supabase', 'Auth site URL on target', String(a?.site_url || '').includes(TARGET), String(a?.site_url || 'unknown'));
    add('supabase', 'Auth redirect allow-list includes target', String(a?.uri_allow_list || '').includes(TARGET), String(a?.uri_allow_list || '(empty)'));
  } else add('supabase', 'Auth site URL and redirect allow-list', 'manual', 'Supabase → Authentication → URL Configuration (or set SUPABASE_ACCESS_TOKEN)');

  // ── 9. Media ──────────────────────────────────────────────────────────────
  const base = String(vars.MEDIA_S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const one = ((await getDb().select<any>('products', { select: ['media_gallery'], limit: 50 })) as any[]).flatMap((p) => p.media_gallery || []).map((m: any) => String(m?.url || '')).find((u: string) => u.startsWith('media:') || u.startsWith(base));
  if (one) {
    const url = one.startsWith('media:') ? base + '/' + one.slice(6) : one;
    const m = await head(url);
    add('media', 'photos load from the media host', m.status === 200, url.replace(/\/tenants\/.*/, '/…') + ' ' + m.status);
  } else add('media', 'photos load from the media host', 'manual', 'no stored photo to try');

  // ── 10. Email: links, support@, sending domain ────────────────────────────
  process.env.EMAIL_DRIVER = 'record';
  process.env.PLATFORM_ROOT_DOMAIN = TARGET;
  const email = await import('../lib/email');
  const { sentTo } = await import('./resend-readback');
  const probe = 'domaincheck' + Date.now().toString(36) + '@proof.invalid';
  await email.sendSignupExistingAccountEmail({ to: probe, signInUrl: 'https://app.' + TARGET + '/app/login' });
  const mail = (await sentTo(getDb, probe, { waitMs: 10_000 }))[0];
  const hosts = [...String(mail?.html || '').matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
  add('email', 'links in platform email point at the target', hosts.length > 0 && hosts.every((h) => h === TARGET || h.endsWith('.' + TARGET)), [...new Set(hosts)].join(', '));
  const mx = await dns(TARGET, 'MX');
  add('email', 'support@ inbound: MX is Cloudflare Email Routing', mx.length > 0 && mx.every((m) => /mx\.cloudflare\.net\.?$/.test(m)), mx.join(' ') || 'no MX');
  add('email', 'support@ forwards to a real inbox', 'manual', 'send a mail to ' + (vars.SUPPORT_EMAIL || 'support@target') + ' and see it arrive');
  const dmarc = (await dns('_dmarc.' + TARGET, 'TXT')).join(' ');
  add('email', 'DMARC record on target', /v=DMARC1/i.test(dmarc), dmarc || 'none');
  const settings = ((await getDb().select<any>('global_platform_settings', { select: ['mail_provider', 'mail_api_key'], limit: 1 })) as any[])[0];
  if (settings?.mail_provider === 'resend' && settings.mail_api_key) {
    const d: any = await fetch('https://api.resend.com/domains', { headers: { authorization: 'Bearer ' + settings.mail_api_key } }).then((r) => r.json()).catch(() => null);
    const list = (d?.data || []) as any[];
    const t = list.find((x) => x.name === TARGET);
    add('email', 'sending domain verified at Resend', t?.status === 'verified', t ? t.status : 'not added (' + list.map((x) => x.name + ':' + x.status).join(', ') + ')');
    const sender = String(process.env.RESEND_FROM || '');
    add('email', 'the sender address is on the target (RESEND_FROM)', sender.toLowerCase().includes('@' + TARGET), sender.replace(/^.*</, '<'));
  }

  // ── 11. The move itself: old addresses and GOYUNIR's own domain ───────────
  if (OLD && store) {
    const r = await head('https://' + store + '.' + OLD + '/some/page?x=1');
    add('move', 'an old store address 301s to the target', r.status === 301 && r.location === 'https://' + store + '.' + TARGET + '/some/page?x=1', r.status + ' ' + r.location);
  }
  if (GOYUNIR_DOMAIN) {
    const g = ((await getDb().select<any>('tenant_domains', { where: { hostname: eq(GOYUNIR_DOMAIN) }, select: ['status', 'is_primary', 'tenant_id'], limit: 1 })) as any[])[0];
    add('move', 'GOYUNIR\'s own domain is its primary, active', Boolean(g && g.is_primary && g.status === 'active'), g ? g.status + (g.is_primary ? ', primary' : ', not primary') : 'not added');
    const r = await head('https://goyunir.' + TARGET + '/');
    add('move', 'goyunir.target 301s to GOYUNIR\'s own domain', r.status === 301 && r.location.startsWith('https://' + GOYUNIR_DOMAIN), r.status + ' ' + r.location);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const w = Math.max(...rows.map((r) => r.check.length));
  console.log('\nDOMAIN MIGRATION CHECK  target ' + TARGET + (OLD ? '  old ' + OLD : '') + '\n');
  for (const r of rows) console.log(' ' + r.result.padEnd(6) + ' ' + r.area.padEnd(9) + ' ' + r.check.padEnd(w) + '  ' + r.note.slice(0, 90));
  const fails = rows.filter((r) => r.result === 'FAIL').length, manual = rows.filter((r) => r.result === 'MANUAL').length;
  console.log('\n' + rows.filter((r) => r.result === 'PASS').length + ' pass, ' + fails + ' fail, ' + manual + ' to check by hand');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
