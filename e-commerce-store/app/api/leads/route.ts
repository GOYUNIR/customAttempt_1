import { NextResponse } from 'next/server';
import { classifyHost, resolveRequestHost } from '@/lib/edge-router';
import { verifyTurnstile } from '@/lib/turnstile';
import { clientIp, isRateLimited } from '@/lib/rate-limit';
import { isDisposableEmail } from '@/lib/signup-guard';
import { createKvClient } from '@/lib/server-config';
import { parseLeadInput } from '@/lib/leads-rules';
import { captureLead, leadsEnabled } from '@/lib/leads';
import { sendSalesLeadEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

/**
 * /api/leads — "talk to us" from the platform's own site (lib/leads.ts).
 * Off unless PLATFORM_LEADS_ENABLED=true (then a 404, as if it did not exist).
 * Only on the platform's root domain: a store's address never takes our leads.
 * Abuse protection, in order (the same tools as signup):
 *   origin          the request comes from our own site
 *   size            a small body only
 *   per-IP limit    5 per 10 minutes
 *   honeypot        a hidden field people never fill: a bot that does is dropped quietly
 *   Turnstile       verified server-side, fail closed
 *   input rules     a real email, a message; disposable addresses refused
 *   daily ceiling   past 200 leads a day, quietly dropped (and logged)
 * One reply for every accepted or quietly dropped request: it says nothing
 * about what happened to any one of them.
 */
const SAME_REPLY = { ok: true, message: 'Thanks. We read every message, and a person will reply by email.' };
const DAILY_CEILING = 200;
const root = () => String(process.env.PLATFORM_ROOT_DOMAIN || '').trim().toLowerCase();
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });
const notHere = () => new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

function onPlatformRoot(request: Request): boolean {
  const host = resolveRequestHost({ xForwardedHost: request.headers.get('x-forwarded-host'), host: request.headers.get('host') });
  return Boolean(root()) && classifyHost(host, root()) === 'marketing';
}

export async function GET(request: Request) {
  if (!leadsEnabled() || !onPlatformRoot(request)) return notHere();
  return NextResponse.json({ enabled: true, siteKey: process.env.TURNSTILE_SITE_KEY || null });
}

export async function POST(request: Request) {
  try {
    if (!leadsEnabled() || !onPlatformRoot(request)) return notHere();
    const origin = String(request.headers.get('origin') || '').toLowerCase();
    if (origin !== 'https://' + root()) return fail(403, 'Send this from our site.');
    if (Number(request.headers.get('content-length') || 0) > 10_000) return fail(413, 'That message is too long.');
    if (await isRateLimited('lead-capture', request, 5, 600)) return fail(429, 'Too many messages from this connection. Please try again in a few minutes.');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (String(body.website || '').trim()) { console.warn('[leads] honeypot filled, dropped quietly'); return NextResponse.json(SAME_REPLY); }

    const ip = clientIp(request);
    const human = await verifyTurnstile({ token: String(body.turnstileToken || ''), ip });
    if (!human.ok) {
      return human.reason === 'unavailable'
        ? fail(503, 'We could not check that you are a person right now. Please try again in a moment, or email us.')
        : fail(400, 'Please complete the check that you are a person, then send again.', { code: 'TURNSTILE' });
    }
    const parsed = parseLeadInput(body);
    if (!parsed.ok) return fail(400, parsed.error, { field: parsed.field });
    if (await isDisposableEmail(parsed.lead.email)) return fail(400, 'Please use a permanent email address so we can reply.', { field: 'email' });

    // A day's ceiling, so a flood that gets past the rest cannot fill the table
    // or the sales inbox. Fails open (a KV outage must not lose real leads).
    try {
      const kv: any = createKvClient();
      if (kv) {
        const key = 'leads:day:' + new Date().toISOString().slice(0, 10);
        const n = Number(await kv.incr(key));
        if (n === 1) await kv.expire(key, 2 * 86400);
        if (n > DAILY_CEILING) { console.error('[leads] daily ceiling reached (' + DAILY_CEILING + '): dropped quietly'); return NextResponse.json(SAME_REPLY); }
      }
    } catch { /* fail open */ }

    const { isNew } = await captureLead(parsed.lead, { ip });
    if (isNew) {
      const l = parsed.lead;
      const sent = await sendSalesLeadEmail({
        subject: 'New lead: ' + (l.company || l.name || l.email),
        lines: ['From: ' + (l.name ? l.name + ' ' : '') + '<' + l.email + '>' + (l.company ? ', ' + l.company : ''), 'Came from: ' + l.source, '', l.message, '', 'Claim it in the Sales Hub, Pipeline. The clock is running.'],
      }).catch((e) => ({ ok: false, error: e }));
      if (!sent.ok) console.error('[leads] the sales inbox was not told about a new lead (it is in the Pipeline):', (sent as any).error || 'not sent');
    }
    return NextResponse.json(SAME_REPLY);
  } catch (err) {
    console.error('[leads] capture failed', (err as Error)?.message || err);
    return fail(500, 'We could not take your message just now. Please try again, or email us.');
  }
}
