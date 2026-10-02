/**
 * SPEED TO LEAD (lib/leads.ts): isolation and abuse, proven.
 *
 *   npx tsx scripts/verify-leads.ts
 *
 * Over HTTP against production (the flag is OFF there):
 *   - the public form does not exist (404) while off;
 *   - the Pipeline API: no session 401; a merchant owner's session 403 on the
 *     sales host and 404 on the merchant host; a store's address 404;
 *   - two sales reps claim one lead at the same moment: exactly one wins;
 *     "replied" is recorded once; status rules.
 * In this process, with the flag ON here only and Cloudflare's published
 * Turnstile TEST secrets (the signup proof's method), the real route code:
 *   - only on the platform root; origin required; forged or missing
 *     Turnstile refused; bad and disposable emails refused; the honeypot
 *     drops quietly; the per-IP limit; the daily ceiling; one reply for all;
 *   - a new lead tells the sales inbox once; the same person again is the
 *     same lead (no second notice);
 *   - a lead unanswered for 15 minutes is nudged ONCE.
 * Mail: the record stub (sink), never sent. Cleans up its leads, counters and
 * accounts (the gate's teardown removes the accounts' rows).
 */
import { ROOT } from './proof-config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
process.env.PLATFORM_ROOT_DOMAIN = ROOT;
process.env.PLATFORM_LEADS_ENABLED = 'true';            // this process only
process.env.EMAIL_DRIVER = 'record';                     // never real mail
process.env.TURNSTILE_EXPECTED_HOSTNAMES = 'example.com'; // what Cloudflare's test keys report
const PASS = '1x0000000000000000000000000000000AA', FAIL = '2x0000000000000000000000000000000AA';
process.env.TURNSTILE_SECRET_KEY = PASS;
const SINK = String(process.env.EMAIL_SINK_DOMAINS || '').split(',')[0].trim() || 'proof.invalid';
const run = Date.now().toString(36);
process.env.SALES_LEADS_EMAIL = 'salesleads' + run + '@' + SINK;

const APP = 'https://app.' + ROOT, SALES = 'https://sales.' + ROOT, DEMO = 'https://demo.' + ROOT;
const A = '13591c9e-82e4-4c23-8d94-249cef6fa775'; // test4: its owner is a merchant
let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { POST } = await import('../app/api/leads/route');
  const { nudgeColdLeads } = await import('../lib/leads');
  const { sendSalesLeadEmail } = await import('../lib/email');
  const { getDb } = await import('../lib/db/client');
  const { eq, like } = await import('../lib/db/query');
  const { createKvClient } = await import('../lib/server-config');
  const { createInvite } = await import('../lib/staff-invites');
  const { readStaffIdentity, deviceMetaFor } = await import('../lib/staff-identity');
  const { issueAdminDevice } = await import('../lib/admin-verify');
  const { sentTo } = await import('./resend-readback');
  const db = getDb(); const kv: any = createKvClient();
  const proofEmail = (label: string) => label + run + '@' + SINK;
  const leadsOf = async (email: string) => (await db.select<any>('platform_leads', { where: { email: eq(email) }, select: ['id', 'source', 'message', 'status', 'claimed_by', 'first_response_at', 'nudged_at'] })) as any[];
  const ips: string[] = [];
  const post = async (body: Record<string, unknown>, o: { host?: string; origin?: string | null; ip?: string } = {}) => {
    const ip = o.ip || '192.0.2.' + (100 + ips.length % 100); ips.push(ip);
    const headers: Record<string, string> = { 'content-type': 'application/json', host: o.host ?? ROOT, 'cf-connecting-ip': ip };
    if (o.origin !== null) headers.origin = o.origin ?? 'https://' + ROOT;
    const res = await POST(new Request('https://' + (o.host ?? ROOT) + '/api/leads', { method: 'POST', headers, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const good = (email: string, extra: Record<string, unknown> = {}) => ({ email, name: 'Proof Person', company: 'Proof Co', message: 'We sell in drops and want to talk (proof ' + run + ').', source: 'pricing_scale', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX', ...extra });

  // Two temporary sales reps through the real invite + accept flow.
  const rep = async (label: string) => {
    const email = 'leads-' + label + '-' + run + '@goyunir.invalid';
    const inv: any = await createInvite({ email, role: 'sales', tenantId: null, invitedByEmail: 'leads-proof@goyunir.invalid' });
    const acc = await fetch(SALES + '/api/admin/accept-invite', { method: 'POST', headers: { 'content-type': 'application/json', origin: SALES }, body: JSON.stringify({ token: inv.token, password: 'Ld-' + crypto.randomUUID() + '-Aa1!' }) });
    const id = await readStaffIdentity(email);
    if (acc.status !== 200 || !id) throw new Error('could not make the sales account ' + label + ': ' + acc.status);
    return { email, token: (await issueAdminDevice(kv, email, false, deviceMetaFor(id), 900)).token };
  };
  const api = async (base: string, token: string | null, init: RequestInit = {}) => {
    const r = await fetch(base + '/api/admin/sales/leads', { ...init, headers: { ...(init.headers as any || {}), ...(token ? { cookie: 'goyunir_admin_device=' + token } : {}), origin: base, 'content-type': 'application/json' } });
    let body: any = null; try { body = await r.json(); } catch { /* */ }
    return { status: r.status, body };
  };

  const made: string[] = [];
  // Today's lead counter as this run found it (for the ceiling check).
  const dayKey = 'leads:day:' + new Date().toISOString().slice(0, 10);
  const dayStart = await kv.get(dayKey).catch(() => null);
  try {
    console.log('\nWhile the flag is off in production');
    check((await fetch('https://' + ROOT + '/api/leads', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://' + ROOT }, body: '{}' })).status === 404, 'the public form does not exist (404)');

    console.log('\nWho can see the Pipeline');
    const ownerA = ((await db.select<any>('users', { where: { tenant_id: eq(A), role: eq('owner') }, select: ['email'], limit: 1 })) as any[])[0].email;
    const merchant = (await issueAdminDevice(kv, ownerA, false, deviceMetaFor((await readStaffIdentity(ownerA))!), 600)).token;
    check((await api(SALES, null)).status === 401, 'no session: 401');
    check((await api(SALES, merchant)).status === 403, 'a merchant owner\'s session on the sales host: 403');
    check((await api(APP, merchant)).status === 404, 'on the merchant host: 404 (not served there at all)');
    check((await api(DEMO, null)).status === 404, 'on a store\'s address: 404');

    console.log('\nThe form: abuse (real route code, flag on in this process)');
    check((await post(good(proofEmail('host')), { host: 'demo.' + ROOT, origin: DEMO })).status === 404, 'only on the platform root: a store address gets 404');
    check((await post(good(proofEmail('origin')), { origin: null })).status === 403, 'no origin: 403');
    check((await post(good(proofEmail('origin2')), { origin: 'https://evil.example' })).status === 403, 'another site\'s origin: 403');
    process.env.TURNSTILE_SECRET_KEY = FAIL;
    const forged = await post(good(proofEmail('forged')));
    process.env.TURNSTILE_SECRET_KEY = PASS;
    check(forged.status === 400 && forged.body?.code === 'TURNSTILE', 'a forged person-check: refused (400)');
    check((await post(good(proofEmail('notoken'), { turnstileToken: '' }))).status === 400, 'no person-check token: refused');
    check((await post(good('not-an-email'))).body?.field === 'email', 'a bad email: refused');
    check((await post(good('someone@mailinator.com'))).status === 400, 'a disposable email: refused');
    const bot = await post(good(proofEmail('honeypot'), { website: 'http://spam.example' }));
    check(bot.status === 200 && (await leadsOf(proofEmail('honeypot'))).length === 0, 'the honeypot: the same reply, nothing stored');

    console.log('\nA real lead');
    const who = proofEmail('lead');
    made.push(who);
    const first = await post(good(who));
    const stored = await leadsOf(who);
    check(first.status === 200 && first.body?.message === bot.body?.message, 'the same reply as the dropped bot (it says nothing about what happened)');
    check(stored.length === 1 && stored[0].source === 'pricing_scale' && stored[0].status === 'new', 'stored once, with where it came from');
    const notices = async () => (await sentTo(getDb, process.env.SALES_LEADS_EMAIL!, { waitMs: 8000 })).filter((m: any) => /New lead/.test(m.subject));
    const n1 = await notices();
    check(n1.length === 1 && String(n1[0].html).includes(who), 'the sales inbox is told once (recorded in the sink)');
    await post(good(who, { message: 'Second thought ' + run }));
    const again = await leadsOf(who);
    check(again.length === 1 && String(again[0].message).includes('Second thought'), 'the same person again: the same lead, message added');
    check((await notices()).length === 1, 'and no second notice');

    console.log('\nThe per-IP limit and the daily ceiling');
    const ip = '198.51.100.' + (Date.now() % 200);
    let limited = false;
    for (let i = 0; i < 7 && !limited; i++) limited = (await post(good(proofEmail('rl' + i)), { ip })).status === 429;
    check(limited, 'more than 5 in 10 minutes from one connection: 429');
    for (let i = 0; i < 7; i++) made.push(proofEmail('rl' + i));
    // Reach the ceiling the way traffic would (incr), on today's counter, then
    // remove it. Only when nothing real has counted today (leads are off in
    // production); otherwise skipped rather than disturbing a real count.
    if (dayStart === null || dayStart === undefined) {
      // Every count today is this run's own: top it up to the ceiling.
      let n = Number((await kv.get(dayKey).catch(() => 0)) || 0);
      while (n < 200) n = Number(await kv.incr(dayKey));
      const ceiling = await post(good(proofEmail('ceiling')));
      const ceilingRows = await leadsOf(proofEmail('ceiling'));
      check(ceiling.status === 200 && ceilingRows.length === 0, 'past the day\'s ceiling: the same reply, nothing stored (' + ceiling.status + ', ' + ceilingRows.length + ' stored)');
      await kv.del(dayKey);
    } else {
      console.log('  (the daily ceiling check is skipped: today\'s counter held ' + dayStart + ' before this run)');
    }

    console.log('\nThe Pipeline (production code, two reps)');
    const r1 = await rep('a'), r2 = await rep('b');
    const list = await api(SALES, r1.token);
    const row = (list.body?.leads || []).find((l: any) => l.email === who);
    check(list.status === 200 && Boolean(row) && typeof row.waited === 'string', 'a rep sees the lead and how long it has waited (' + row?.waited + ')');
    const [c1, c2] = await Promise.all([
      api(SALES, r1.token, { method: 'POST', body: JSON.stringify({ id: row.id, action: 'claim' }) }),
      api(SALES, r2.token, { method: 'POST', body: JSON.stringify({ id: row.id, action: 'claim' }) }),
    ]);
    const winners = [c1, c2].filter((c) => c.status === 200);
    const owner = winners[0]?.body?.lead?.claimed_by;
    check(winners.length === 1 && [c1, c2].some((c) => c.status === 409), 'two reps claim at once: exactly one wins (' + owner + '), the other is told who has it');
    const ownerTok = owner === r1.email ? r1.token : r2.token;
    const replied = await api(SALES, ownerTok, { method: 'POST', body: JSON.stringify({ id: row.id, action: 'responded' }) });
    const firstAt = replied.body?.lead?.first_response_at;
    await sleep(1500);
    const repliedAgain = await api(SALES, ownerTok, { method: 'POST', body: JSON.stringify({ id: row.id, action: 'responded' }) });
    check(Boolean(firstAt) && replied.body?.lead?.status === 'working' && repliedAgain.body?.lead?.first_response_at === firstAt, 'the first reply is recorded once (the metric\'s end does not move)');
    check((await api(SALES, ownerTok, { method: 'POST', body: JSON.stringify({ id: row.id, action: 'status', status: 'deleted' }) })).status === 400, 'an unknown status: 400');
    check((await api(SALES, ownerTok, { method: 'POST', body: JSON.stringify({ id: row.id, action: 'status', status: 'won' }) })).body?.lead?.status === 'won', 'marked won');

    console.log('\nThe cold-lead nudge (once)');
    const coldEmail = proofEmail('cold');
    made.push(coldEmail);
    await db.insert('platform_leads', { email: coldEmail, message: 'cold proof ' + run, source: 'proof', created_at: new Date(Date.now() - 20 * 60_000).toISOString() }, { returning: 'minimal' } as any);
    const sendNudge = (subject: string, lines: string[]) => sendSalesLeadEmail({ subject, lines });
    const n = await nudgeColdLeads(new Date(), sendNudge);
    const nudged = (await leadsOf(coldEmail))[0];
    check(n.sent && n.nudged >= 1 && Boolean(nudged?.nudged_at), 'a lead unanswered for 15 minutes: the sales inbox is told (' + n.nudged + ' lead(s))');
    const mail = (await sentTo(getDb, process.env.SALES_LEADS_EMAIL!, { waitMs: 8000 })).find((m: any) => /waiting over/.test(m.subject));
    check(Boolean(mail) && String(mail.html).includes(coldEmail), 'the reminder names it and says it is not claimed');
    await nudgeColdLeads(new Date(), sendNudge);
    const after = (await leadsOf(coldEmail))[0];
    const reminders = (await sentTo(getDb, process.env.SALES_LEADS_EMAIL!, { waitMs: 3000 })).filter((m: any) => /waiting over/.test(m.subject) && String(m.html).includes(coldEmail));
    check(after?.nudged_at === nudged?.nudged_at && reminders.length === 1, 'run again: not nudged twice (one reminder for it, its mark unchanged)');
  } finally {
    if (dayStart === null || dayStart === undefined) await kv.del(dayKey).catch(() => null);
    for (const e of made) await db.remove('platform_leads', { where: { email: eq(e) } }).catch(() => null);
    await db.remove('platform_leads', { where: { email: like('%' + run + '@' + SINK) } }).catch(() => null);
    const { rateLimitKey } = await import('../lib/redis-keys');
    for (const ip of new Set(ips)) await kv.del(rateLimitKey('lead-capture', ip)).catch(() => null);
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
