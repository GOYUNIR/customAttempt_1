/**
 * SIGNUP ABUSE SIMULATION — the real signup route code, in this process,
 * against the PRODUCTION database and KV counters, with Cloudflare's
 * published Turnstile TEST secrets (always pass / always fail / already
 * spent). Production's own ALLOW_MERCHANT_SIGNUP is not touched.
 *
 * SENDS NO REAL EMAIL. EMAIL_DRIVER=record makes the governed email driver
 * (services/email/governor.ts) record every message in the `email_sink` table
 * on the sink's own counters, so the run spends nothing of any provider's
 * daily allowance (on 2026-10-01 earlier runs used Resend's whole 100/day).
 *
 *   npx tsx scripts/verify-signup-abuse.ts
 *
 * Proves: Turnstile forged / replayed / unavailable / wrong-host refused; no
 * account enumeration (identical replies, different emails); per-email resend
 * cooldown; disposable emails refused; 50 signups from one IP stopped by
 * escalating waits WITHOUT tripping the global breaker; concurrent signups for
 * one name → exactly one; reserved/lookalike/taken names refused; a flood
 * across many IPs trips the breaker (alert sent once) and it recovers; the
 * signup-email budget stops sends. Cleans up its counters, policy changes and
 * temporary account; its pending signups expire by themselves (48 h).
 */
import { ROOT, ROOT_RE, SUPPORT_EMAIL } from './proof-config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const envPath = join(process.cwd(), '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1'); }
process.env.USE_POSTGRES_PRIMARY = 'true';
process.env.PLATFORM_ROOT_DOMAIN = ROOT;
process.env.STOREFRONT_LEGACY_HOSTS = 'shop,www,api,goyunir';
process.env.ALLOW_MERCHANT_SIGNUP = 'true';           // this process only
process.env.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || SUPPORT_EMAIL; // production's (wrangler vars): breaker alerts go there
process.env.EMAIL_DRIVER = 'record';                   // never real mail (see above)
process.env.TURNSTILE_EXPECTED_HOSTNAMES = 'example.com'; // what Cloudflare's test keys report
const PASS = '1x0000000000000000000000000000000AA', FAIL = '2x0000000000000000000000000000000AA', SPENT = '3x0000000000000000000000000000000AA';
process.env.TURNSTILE_SECRET_KEY = PASS;

let failures = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? '  PASS ' : '  FAIL ') + what); if (!ok) failures++; };
const run = Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SINK_DOMAIN = String(process.env.EMAIL_SINK_DOMAINS || '').split(',')[0].trim() || 'proof.invalid';
const inbox = (label: string) => label.replace(/[^a-z0-9]/gi, '').toLowerCase() + run + '@' + SINK_DOMAIN;

(async () => {
  const { POST } = await import('../app/api/signup/merchant/route');
  const { getDb } = await import('../lib/db/client');
  const { eq, like } = await import('../lib/db/query');
  const { createKvClient } = await import('../lib/server-config');
  const { sentTo } = await import('./resend-readback');
  const db = getDb(); const kv: any = createKvClient();
  const ips: string[] = [];
  const signup = async (o: { email: string; storeName: string; ip: string; token?: string; terms?: boolean }) => {
    ips.push(o.ip); emails.add(o.email.toLowerCase());
    const res = await POST(new Request('https://' + ROOT + '/api/signup/merchant', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': o.ip },
      body: JSON.stringify({ email: o.email, storeName: o.storeName, acceptTerms: o.terms ?? true, turnstileToken: o.token ?? 'XXXX.DUMMY.TOKEN.XXXX' }),
    }));
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const pending = async (email: string) => ((await db.select<any>('merchant_signups', { where: { email: eq(email), status: eq('pending') }, select: ['slug', 'terms_version', 'terms_accepted_at', 'ip'] })) as any[]);
  const setPolicy = async (key: string, value: unknown) => db.update('platform_policies', { where: { key: eq(key) } }, { value }, { returning: 'minimal' } as any);
  const policyBefore = Object.fromEntries(((await db.select<any>('platform_policies', { select: ['key', 'value'] })) as any[]).map((r) => [r.key, r.value]));
  const clearProofCounters = async () => {
    const day = new Date().toISOString().slice(0, 10), hour = new Date().toISOString().slice(0, 13);
    await kv.del('signup:domain:d:' + day + ':' + SINK_DOMAIN, 'signup:alert:' + hour).catch(() => null);
    for (const e of emails) await kv.del('signup:email:d:' + day + ':' + e, 'signup:sent:d:' + day + ':' + e, 'signup:sent:last:' + e).catch(() => null);
    // Every proof IP is in the reserved documentation ranges (never a real
    // visitor). Clear them ALL, not just this run's: a run that died part-way
    // left its per-IP day count, and the next run's "50 from one IP" then hit
    // the daily limit early (found 2026-10-01).
    for (const net of ['192.0.2.', '198.51.100.', '203.0.113.']) {
      const keys: string[] = [];
      for (let i = 0; i < 100; i++) keys.push('signup:ip:h:' + hour + ':' + net + i, 'signup:ip:d:' + day + ':' + net + i, 'signup:ip:last:' + net + i);
      for (let i = 0; i < keys.length; i += 50) await kv.del(...keys.slice(i, i + 50)).catch(() => null);
    }
  };
  const emails = new Set<string>();
  const tempEmail = inbox('existing');
  let tempUserId = '';

  // Earlier runs today leave per-domain counters: every proof address is on
  // the sink domain, which the per-domain limit counts. Start (and end) clean.
  await clearProofCounters();
  // The sink's limits are data like any provider's. Roomy for the run (so the
  // email share is not what stops the earlier sections), tight for the budget
  // section; restored afterwards.
  const { clearEmailPlanCache } = await import('../services/email/factory');
  const sinkPlanBefore = ((await db.select<any>('email_provider_plans', { where: { provider: eq('sink'), active: eq(true) }, select: ['plan', 'daily_limit'], limit: 1 })) as any[])[0];
  if (!sinkPlanBefore) throw new Error('migration 00042 (email_provider_plans) is not applied');
  const setSinkDaily = async (n: number) => { await db.update('email_provider_plans', { where: { provider: eq('sink'), plan: eq(sinkPlanBefore.plan) } }, { daily_limit: n }, { returning: 'minimal' } as any); clearEmailPlanCache(); };
  await setSinkDaily(100_000);
  try {
    console.log('\nTurnstile (server-side, fail closed)');
    process.env.TURNSTILE_SECRET_KEY = FAIL;
    check((await signup({ email: inbox('t1'), storeName: 'Proof T1 ' + run, ip: '198.51.100.1' })).status === 400, 'a forged or expired token is refused (400)');
    process.env.TURNSTILE_SECRET_KEY = SPENT;
    check((await signup({ email: inbox('t2'), storeName: 'Proof T2 ' + run, ip: '198.51.100.1' })).status === 400, 'a replayed (already spent) token is refused (400)');
    process.env.TURNSTILE_SECRET_KEY = '';
    check((await signup({ email: inbox('t3'), storeName: 'Proof T3 ' + run, ip: '198.51.100.1' })).status === 503, 'verification unavailable: refused, not waved through (503)');
    process.env.TURNSTILE_SECRET_KEY = PASS; process.env.TURNSTILE_EXPECTED_HOSTNAMES = ROOT;
    check((await signup({ email: inbox('t4'), storeName: 'Proof T4 ' + run, ip: '198.51.100.1' })).status === 400, 'a token solved on another hostname is refused (400)');
    process.env.TURNSTILE_EXPECTED_HOSTNAMES = 'example.com';

    console.log('\nNo account enumeration');
    // A real account for an inbox we can read: an auth user + its users row.
    const sc = await import('../services/config/supabase-client');
    const authUser: any = await sc.supabaseAuthFetch('/admin/users', { key: sc.readSupabaseEnv().serviceRoleKey, method: 'POST', body: { email: tempEmail, password: 'Proof-' + crypto.randomUUID() + '-Aa1!', email_confirm: true } });
    tempUserId = String(authUser?.id || authUser?.user?.id || '');
    if (!tempUserId) throw new Error('could not create the temporary account');
    await db.insert('users', { id: tempUserId, email: tempEmail, role: 'staff', tenant_id: null }, { onConflict: 'id', returning: 'minimal' } as any);
    const fresh = inbox('fresh');
    const a = await signup({ email: fresh, storeName: 'Proof Fresh ' + run, ip: '198.51.100.2' });
    const b = await signup({ email: tempEmail, storeName: 'Proof Existing ' + run, ip: '198.51.100.3' });
    check(a.status === 200 && b.status === 200 && JSON.stringify(a.body) === JSON.stringify(b.body), 'new email and existing account get the IDENTICAL reply: ' + JSON.stringify(a.body));
    const mFresh = await sentTo(getDb, fresh, { waitMs: 60000 });
    const mExisting = await sentTo(getDb, tempEmail, { waitMs: 60000 });
    check(/Confirm your email to open/.test(mFresh[0]?.subject || '') && /You already have an account/.test(mExisting[0]?.subject || ''), 'what differs is only the email each inbox receives: "' + mFresh[0]?.subject + '" / "' + mExisting[0]?.subject + '"');
    const p = await pending(fresh);
    check(p.length === 1 && p[0].terms_version === '2026-09-27-draft' && Boolean(p[0].terms_accepted_at) && p[0].ip === '198.51.100.2', 'terms acceptance logged with version, time and IP: ' + JSON.stringify(p[0]));
    check((await pending(tempEmail)).length === 0, 'no name is held for the existing account');
    check((await signup({ email: inbox('noterms'), storeName: 'Proof NT ' + run, ip: '198.51.100.4', terms: false })).status === 400, 'terms not accepted: refused');

    console.log('\nSame email repeated');
    const rep = inbox('repeat');
    const replies = [];
    for (let i = 0; i < 4; i++) replies.push(await signup({ email: rep, storeName: 'Proof Repeat ' + run, ip: '198.51.100.' + (10 + i) }));
    check(replies.every((r) => r.status === 200 && JSON.stringify(r.body) === JSON.stringify(a.body)), 'four quick requests: four identical replies');
    await sleep(8000);
    check((await sentTo(getDb, rep, { waitMs: 20000 })).length === 1, 'but only ONE email went out (resend cooldown)');

    console.log('\nDisposable email');
    const d = await signup({ email: 'proof' + run + '@mailinator.com', storeName: 'Proof Disp ' + run, ip: '198.51.100.20' });
    check(d.status === 400 && /permanent email/.test(d.body?.error), 'mailinator.com refused: ' + d.body?.error);
    check((await signup({ email: 'proof' + run + '@inbox.mailinator.com', storeName: 'Proof Disp2 ' + run, ip: '198.51.100.21' })).status === 400, 'and its subdomains');

    console.log('\nNames');
    for (const [name, re] of [['PayPal Support', /bank, payment or tech/], ['Admin', /reserved/]] as const) {
      const r = await signup({ email: inbox('name'), storeName: name, ip: '198.51.100.30' });
      check(r.status === 400 && re.test(r.body?.error), JSON.stringify(name) + ' refused: ' + r.body?.error);
    }
    const squat = await signup({ email: inbox('squat'), storeName: 'test4', ip: '198.51.100.31' });
    check(squat.status === 409 && /taken/.test(squat.body?.error), 'an existing store\'s name cannot be squatted: ' + squat.status);
    const race = await Promise.all([0, 1, 2, 3, 4].map((i) => signup({ email: inbox('race' + i), storeName: 'Proof Race ' + run, ip: '198.51.100.' + (40 + i) })));
    check(race.filter((r) => r.status === 200).length === 1 && race.filter((r) => r.status === 409).length === 4, 'five at once for one name: exactly one holds it, four told it is taken: ' + race.map((r) => r.status).join(','));

    console.log('\n50 signups from one IP');
    const flood = [];
    for (let i = 0; i < 50; i++) flood.push(await signup({ email: inbox('ipflood' + i), storeName: 'Proof IP ' + run + ' ' + i, ip: '198.51.100.99' }));
    const okN = flood.filter((r) => r.status === 200).length;
    const waits = flood.filter((r) => r.status === 429 && /wait \d+ minute/.test(r.body?.error)).length;
    const other = flood.filter((r) => r.status !== 200 && !(r.status === 429 && /wait \d+ minute/.test(r.body?.error))).map((r) => r.status + ' ' + (r.body?.error || ''));
    check(okN === 5 && waits === 45, 'the first 5 go through, then escalating waits (not a hard block): ' + okN + ' ok, ' + waits + ' asked to wait' + (other.length ? '; other: ' + [...new Set(other)].join(' | ') : ''));
    // The daily ceiling, from a clean slate: attempt 51 of the day is told "tomorrow".
    const fiftyFirst = await signup({ email: inbox('ipflood50'), storeName: 'Proof IP ' + run + ' 50', ip: '198.51.100.99' });
    check(fiftyFirst.status === 429 && /tomorrow/.test(fiftyFirst.body?.error), 'attempt 51 of the day from that network: ' + fiftyFirst.body?.error);
    check(!(Number(await kv.get('signup:paused_until').catch(() => 0)) > Date.now()), 'one network hammering the form does NOT pause signup for everyone');

    console.log('\nCircuit breaker (flood across many IPs)');
    const hourKey = new Date().toISOString().slice(0, 13);
    const used = Number(await kv.get('signup:g:h:' + hourKey).catch(() => 0)) || 0;
    await setPolicy('signup.global_per_hour', used + 3);
    await setPolicy('signup.breaker_pause_minutes', 1);
    await sleep(31000); // policy cache
    const wave = [];
    for (let i = 0; i < 6; i++) wave.push(await signup({ email: inbox('wave' + i), storeName: 'Proof Wave ' + run + ' ' + i, ip: '203.0.113.' + (10 + i) }));
    const tripped = wave.findIndex((r) => r.status === 503);
    check(tripped === 3 && wave.slice(3).every((r) => r.status === 503 && /paused/.test(r.body?.error)), 'the 4th signup over the hourly limit trips the breaker; the rest are paused: ' + wave.map((r) => r.status).join(','));
    const alerts = await sentTo(getDb, 'support@' + ROOT, { waitMs: 30000 });
    check(alerts.filter((m: any) => /Signup paused itself/.test(m.subject) && Date.parse(m.created_at) > Date.now() - 300000).length === 1, 'the operator got ONE alert email at support@');
    await setPolicy('signup.global_per_hour', policyBefore['signup.global_per_hour']);
    await sleep(65000);
    const after = await signup({ email: inbox('recovered'), storeName: 'Proof Recovered ' + run, ip: '203.0.113.50' });
    check(after.status === 200, 'after the pause it recovers by itself: ' + after.status);

    // Isolate: earlier sections count toward this hour's GLOBAL total, which
    // tripped the real breaker in the middle of a per-domain test.
    const resetGlobal = async () => { const h = new Date().toISOString().slice(0, 13), dd = new Date().toISOString().slice(0, 10); await kv.del('signup:g:h:' + h, 'signup:g:d:' + dd, 'signup:paused_until'); };
    await resetGlobal();
    console.log('\nPer-domain limit (a non-shared domain)');
    const dayK = new Date().toISOString().slice(0, 10);
    await kv.del('signup:domain:d:' + dayK + ':' + SINK_DOMAIN);
    const dom = [];
    for (let i = 0; i < 22; i++) dom.push(await signup({ email: inbox('dom' + i), storeName: 'Proof Dom ' + run + ' ' + i, ip: '192.0.2.' + (10 + i) }));
    const held = ((await db.select<any>('merchant_signups', { where: { slug: like('proof-dom-' + run + '%') }, select: ['slug'], limit: 50 })) as any[]).length;
    check(dom.every((r) => r.status === 200) && held === 20, '22 signups from one non-shared domain: all get the same reply, but only 20 hold a name (the rest are dropped quietly): ' + held);
    await kv.del('signup:domain:d:' + dayK + ':' + SINK_DOMAIN);

    await resetGlobal();
    console.log('\nSignup\'s share of the daily email limit');
    // Make signup's share EXACTLY what is already used today (share 10% of a
    // daily limit of 10x the signup count), leaving room for other mail.
    const today = new Date().toISOString().slice(0, 10);
    const counts = (await db.select<any>('email_send_counts', { where: { provider: eq('sink'), period: eq('day'), period_key: eq(today) }, select: ['category', 'sent'] })) as any[];
    const signupUsed = Number(counts.find((c) => c.category === 'signup')?.sent || 0);
    const allUsed = Number(counts.find((c) => c.category === 'all')?.sent || 0);
    check(signupUsed > 0, 'this run\'s signup mail was counted as signup: ' + signupUsed + ' of ' + allUsed + ' today on the sink');
    await setPolicy('email.signup_daily_share_percent', 10);
    await setSinkDaily(10 * signupUsed);  // 10% of it = exactly what signup used
    check(10 * signupUsed > allUsed, 'the day itself still has room (' + allUsed + ' of ' + 10 * signupUsed + ' used)');
    const capped = await signup({ email: inbox('budget'), storeName: 'Proof Budget ' + run, ip: '203.0.113.60' });
    check(capped.status === 200 && capped.body?.full === true && /tomorrow/.test(capped.body?.message), 'signup\'s share spent: a calm "come back tomorrow" (200, not an error): ' + capped.body?.message);
    check(((await db.select<any>('merchant_signups', { where: { slug: like('proof-budget-' + run + '%') }, select: ['slug'] })) as any[]).length === 0, 'and no store name was taken for it');
    const { sendOperatorAlertEmail } = await import('../lib/email');
    const critical = await sendOperatorAlertEmail({ subject: 'Proof ' + run + ': critical mail still goes', lines: ['Sent by verify-signup-abuse while signup\'s share is spent (to the sink, never delivered).'] });
    check(critical.ok === true, 'while signup is paused, other mail (sign-in codes, orders, alerts) still has room and goes');
  } finally {
    for (const k of Object.keys(policyBefore)) await setPolicy(k, policyBefore[k]).catch(() => null);
    await setSinkDaily(sinkPlanBefore.daily_limit).catch(() => null);
    await kv.del('signup:paused_until').catch(() => null);
    await clearProofCounters();
    const hourKey = new Date().toISOString().slice(0, 13), dayKey = new Date().toISOString().slice(0, 10);
    for (const ip of [...new Set(ips)]) await kv.del('signup:ip:h:' + hourKey + ':' + ip, 'signup:ip:d:' + dayKey + ':' + ip, 'signup:ip:last:' + ip).catch(() => null);
    await kv.del('signup:g:h:' + hourKey, 'signup:g:d:' + dayKey).catch(() => null);
    if (tempUserId) {
      await db.remove('users', { where: { id: eq(tempUserId) } }).catch(() => null);
      const sc = await import('../services/config/supabase-client');
      await sc.supabaseAuthFetch('/admin/users/' + tempUserId, { key: sc.readSupabaseEnv().serviceRoleKey, method: 'DELETE' }).catch(() => null);
    }
    console.log('\ncleanup: policies restored, proof counters and pause cleared, temporary account removed');
  }
  console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
