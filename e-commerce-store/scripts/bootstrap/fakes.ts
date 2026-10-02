/**
 * In-memory stand-ins for Cloudflare, Resend, Stripe and the deployed site,
 * answering the exact calls the bootstrap steps make. Used by the tests and
 * by `run.ts --target local --fake-services` (the rehearsal): the apply path
 * runs end to end without touching a real account.
 */
import type { Http, HttpResponse } from './steps.ts';

export type FakeWorld = {
  zones: Record<string, string>;
  dns: Array<{ zone: string; type: string; name: string; content: string }>;
  buckets: string[];
  widgets: Array<{ sitekey: string; name: string; domains: string[] }>;
  resendDomains: Array<{ id: string; name: string; status: string; records: any[] }>;
  webhooks: Array<{ id: string; url: string; enabled_events: string[]; connect: boolean }>;
  siteConfigured: boolean;
  setupCalls: any[];
  calls: string[];
};

export function fakeWorld(domain: string): FakeWorld {
  return { zones: { [domain]: 'zone-1' }, dns: [], buckets: [], widgets: [], resendDomains: [], webhooks: [], siteConfigured: false, setupCalls: [], calls: [] };
}

const ok = (json: any, status = 200): HttpResponse => ({ status, json });
const parseForm = (body: string) => {
  const out: Record<string, any> = {};
  for (const part of body.split('&')) {
    const [k, v] = part.split('=').map((s) => decodeURIComponent(s));
    if (k.endsWith('[]')) (out[k.slice(0, -2)] = out[k.slice(0, -2)] || []).push(v); else out[k] = v;
  }
  return out;
};

export function fakeHttp(w: FakeWorld): Http {
  let n = 0;
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    w.calls.push(method + ' ' + url.replace(/\?.*$/, ''));
    const u = new URL(url);
    const body = init.body ? (/^\{/.test(init.body) ? JSON.parse(init.body) : parseForm(init.body)) : null;
    if (u.host === 'api.cloudflare.com') {
      const p = u.pathname.replace('/client/v4', '');
      if (p === '/zones') { const id = w.zones[u.searchParams.get('name') || '']; return ok({ success: true, result: id ? [{ id }] : [] }); }
      let m = /^\/zones\/([^/]+)\/dns_records$/.exec(p);
      if (m && method === 'GET') return ok({ success: true, result: w.dns.filter((r) => r.zone === m![1] && (!u.searchParams.get('name') || r.name === u.searchParams.get('name')) && (!u.searchParams.get('type') || r.type === u.searchParams.get('type'))) });
      if (m && method === 'POST') { w.dns.push({ zone: m[1], type: body.type, name: body.name, content: body.content }); return ok({ success: true, result: { id: 'dns-' + ++n } }); }
      m = /^\/accounts\/[^/]+\/r2\/buckets$/.exec(p);
      if (m && method === 'GET') return ok({ success: true, result: { buckets: w.buckets.map((name) => ({ name })) } });
      if (m && method === 'POST') { w.buckets.push(body.name); return ok({ success: true, result: {} }); }
      m = /^\/accounts\/[^/]+\/challenges\/widgets$/.exec(p);
      if (m && method === 'GET') return ok({ success: true, result: w.widgets });
      if (m && method === 'POST') { const wd = { sitekey: '0xFAKE' + ++n, name: body.name, domains: body.domains }; w.widgets.push(wd); return ok({ success: true, result: { ...wd, secret: 'fake-turnstile-secret-' + n } }); }
    }
    if (u.host === 'api.resend.com') {
      if (u.pathname === '/domains' && method === 'GET') return ok({ data: w.resendDomains.map(({ id, name, status }) => ({ id, name, status })) });
      if (u.pathname === '/domains' && method === 'POST') {
        const d = { id: 'rd-' + ++n, name: body.name, status: 'pending', records: [
          { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.example.amazonses.com', priority: 10 },
          { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
          { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=FAKEKEY' },
        ] };
        w.resendDomains.push(d); return ok(d, 200);
      }
      let m = /^\/domains\/([^/]+)$/.exec(u.pathname);
      if (m) return ok(w.resendDomains.find((d) => d.id === m![1]) || null, 200);
      m = /^\/domains\/([^/]+)\/verify$/.exec(u.pathname);
      if (m) return ok({ object: 'domain', id: m[1] });
    }
    if (u.host === 'api.stripe.com') {
      if (u.pathname === '/v1/webhook_endpoints' && method === 'GET') return ok({ data: w.webhooks });
      if (u.pathname === '/v1/webhook_endpoints' && method === 'POST') { const e = { id: 'we_' + ++n, url: body.url, enabled_events: body.enabled_events, connect: body.connect === 'true' }; w.webhooks.push(e); return ok({ ...e, secret: 'whsec_fake' + n }); }
      const m = /^\/v1\/webhook_endpoints\/([^/]+)$/.exec(u.pathname);
      if (m) { const e = w.webhooks.find((x) => x.id === m![1])!; e.enabled_events = body.enabled_events; return ok(e); }
    }
    if (u.pathname === '/api/admin/setup') {
      if (method === 'GET') return ok(w.siteConfigured ? { error: 'AUTH_REQUIRED' } : { configured: false }, w.siteConfigured ? 401 : 200);
      w.setupCalls.push({ ...body, adminPassword: body.adminPassword ? '(given)' : '' });
      w.siteConfigured = true; return ok({ ok: true });
    }
    return ok({ error: 'fake: no route ' + method + ' ' + url }, 404);
  };
}
