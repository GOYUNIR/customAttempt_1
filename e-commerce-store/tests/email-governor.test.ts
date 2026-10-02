import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GovernedEmailDriver, isSinkRecipient, type CapacityStore, type ProviderPlan } from '../services/email/governor.ts';
import { SinkDriver } from '../services/email/sink.driver.ts';
import { CloudflareEmailDriver, cloudflareFailureKind, parseFrom } from '../services/email/cloudflare.driver.ts';
import { resendFailureKind } from '../services/email/resend.driver.ts';
import type { EmailDriver, EmailMessage, EmailSendResult } from '../services/email/types.ts';

/** In-memory twin of email_reserve (00042; the SQL itself is in email-capacity-sql.test.ts). */
function memoryCapacity(): CapacityStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const k = (...p: string[]) => p.join('|');
  const get = (key: string) => counts.get(key) || 0;
  return {
    counts,
    async reserve(p) {
      if (get(k(p.provider, 'day', p.day, '_full'))) return 'daily';
      if (p.dailyLimit != null && get(k(p.provider, 'day', p.day, 'all')) >= p.dailyLimit) return 'daily';
      if (p.monthlyLimit != null && get(k(p.provider, 'month', p.month, 'all')) >= p.monthlyLimit) return 'monthly';
      if (p.category !== 'standard' && p.categoryDailyLimit != null) {
        if (get(k(p.provider, 'day', p.day, p.category)) >= p.categoryDailyLimit) return 'category';
        counts.set(k(p.provider, 'day', p.day, p.category), get(k(p.provider, 'day', p.day, p.category)) + 1);
      }
      counts.set(k(p.provider, 'day', p.day, 'all'), get(k(p.provider, 'day', p.day, 'all')) + 1);
      counts.set(k(p.provider, 'month', p.month, 'all'), get(k(p.provider, 'month', p.month, 'all')) + 1);
      return 'ok';
    },
    async release(p) {
      for (const key of [k(p.provider, 'day', p.day, 'all'), k(p.provider, 'month', p.month, 'all'), k(p.provider, 'day', p.day, p.category)]) counts.set(key, Math.max(0, get(key) - 1));
    },
    async markFull(p) { counts.set(k(p.provider, 'day', p.day, '_full'), 1); },
    async usage(p) { return { day: get(k(p.provider, 'day', p.day, 'all')), month: get(k(p.provider, 'month', p.month, 'all')), category: get(k(p.provider, 'day', p.day, p.category)), full: get(k(p.provider, 'day', p.day, '_full')) > 0 }; },
  };
}

/** A provider that records what it was asked to send and answers as told. */
function fakeProvider(provider: 'cloudflare' | 'resend', answer: (m: EmailMessage) => EmailSendResult = () => ({ ok: true, id: 'x', provider })) {
  const sent: EmailMessage[] = [];
  const driver: EmailDriver = {
    provider, configured: true,
    async send2FA() { throw new Error('the governor builds code emails itself'); },
    async sendTransactional(m) { const r = answer(m); if (r.ok) sent.push(m); return r; },
  };
  return { driver, sent };
}

const plan = (provider: string, dailyLimit: number | null, monthlyLimit: number | null, priority: number): ProviderPlan => ({ provider, plan: 'p', dailyLimit, monthlyLimit, priority });
const msg = (to: string, category: 'standard' | 'signup' = 'standard'): EmailMessage => ({ to, from: '', subject: 's', html: '<p>h</p>', meta: { category, tenantId: 't1' } });

function setup(opts: { cfAnswer?: (m: EmailMessage) => EmailSendResult; rsAnswer?: (m: EmailMessage) => EmailSendResult; cfDaily?: number | null; rsDaily?: number | null; recordOnly?: boolean } = {}) {
  const cf = fakeProvider('cloudflare', opts.cfAnswer);
  const rs = fakeProvider('resend', opts.rsAnswer);
  const sink: EmailMessage[] = [];
  const ledger: Array<{ provider: string; to: string }> = [];
  const capacity = memoryCapacity();
  const gov = new GovernedEmailDriver({
    // Listed fallback-first on purpose: order comes from priority (data), not position.
    chain: [{ driver: rs.driver, plan: plan('resend', opts.rsDaily === undefined ? 100 : opts.rsDaily, 3000, 20) }, { driver: cf.driver, plan: plan('cloudflare', opts.cfDaily === undefined ? 10 : opts.cfDaily, null, 10) }],
    sink: new SinkDriver(async (m) => { sink.push(m); return 'sink-id'; }),
    sinkPlan: plan('sink', 100, null, 0),
    capacity, signupSharePercent: 40, recordOnly: opts.recordOnly,
    onSent: async ({ provider, message }) => { ledger.push({ provider, to: message.to }); },
    defaultFrom: 'Platform <notifications@platform.example>', brandName: 'Platform',
    now: () => new Date('2026-10-01T12:00:00Z'),
  });
  return { gov, cf, rs, sink, ledger, capacity };
}

test('reserved test domains never reach a real provider', async () => {
  for (const to of ['a@x.invalid', 'b@shop.test', 'c@example.com', 'd@mail.example.org', 'e@x.example', 'f@localhost']) assert.ok(isSinkRecipient(to), to);
  for (const to of ['a@gmail.com', 'b@example.com.evil.io', 'c@invalid.com', 'd@resend.dev']) assert.ok(!isSinkRecipient(to), to);
  assert.ok(isSinkRecipient('a@proof.goyunir.com', ['proof.goyunir.com']), 'configured sink domains');
  const { gov, cf, rs, sink, ledger } = setup();
  const r = await gov.sendTransactional(msg('owner@goyunir.invalid'));
  assert.ok(r.ok);
  assert.equal(cf.sent.length + rs.sent.length, 0, 'no provider was called');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].from, 'Platform <notifications@platform.example>', 'the sink records the real sender');
  assert.deepEqual(ledger, [{ provider: 'sink', to: 'owner@goyunir.invalid' }]);
});

test('record mode (simulations): everything goes to the sink, even real-looking addresses', async () => {
  const { gov, cf, rs, sink } = setup({ recordOnly: true });
  assert.ok((await gov.sendTransactional(msg('someone@gmail.com'))).ok);
  assert.equal(cf.sent.length + rs.sent.length, 0);
  assert.equal(sink.length, 1);
});

test('Cloudflare is tried first (priority is data), and each send is counted ONCE', async () => {
  const { gov, cf, rs, ledger, capacity } = setup();
  assert.ok((await gov.sendTransactional(msg('a@gmail.com'))).ok);
  assert.equal(cf.sent.length, 1);
  assert.equal(rs.sent.length, 0);
  assert.deepEqual(ledger, [{ provider: 'cloudflare', to: 'a@gmail.com' }], 'one ledger row');
  assert.equal(capacity.counts.get('cloudflare|day|2026-10-01|all'), 1);
  assert.equal(gov.provider, 'cloudflare');
});

test('sign-in codes go through the same door (they were never counted before)', async () => {
  const { gov, cf, ledger } = setup();
  assert.ok((await gov.send2FA('a@gmail.com', '123456', { subject: 'Your code: 123456', meta: { tenantId: 't1' } })).ok);
  assert.equal(cf.sent.length, 1);
  assert.match(cf.sent[0].html, /123456/);
  assert.equal(cf.sent[0].from, 'Platform <notifications@platform.example>');
  assert.equal(ledger.length, 1);
});

test('primary full by OUR count: the fallback takes over', async () => {
  const { gov, cf, rs } = setup({ cfDaily: 2 });
  for (let i = 0; i < 4; i++) assert.ok((await gov.sendTransactional(msg('a' + i + '@gmail.com'))).ok);
  assert.equal(cf.sent.length, 2);
  assert.equal(rs.sent.length, 2);
});

test('primary says ITS daily limit is reached: marked full for the day, fallback used, primary not asked again', async () => {
  let asked = 0;
  const { gov, cf, rs, capacity } = setup({ cfAnswer: () => { asked++; return { ok: false, provider: 'cloudflare', failure: 'full', error: 'E_DAILY_LIMIT_EXCEEDED' }; } });
  assert.ok((await gov.sendTransactional(msg('a@gmail.com'))).ok);
  assert.ok((await gov.sendTransactional(msg('b@gmail.com'))).ok);
  assert.equal(asked, 1, 'asked once, then skipped for the day');
  assert.equal(cf.sent.length, 0);
  assert.equal(rs.sent.length, 2);
  assert.equal(capacity.counts.get('cloudflare|day|2026-10-01|all'), 0, 'its slot was given back');
});

test('primary errors (5xx, network, not onboarded): slot released, fallback sends', async () => {
  const { gov, rs, capacity } = setup({ cfAnswer: () => ({ ok: false, provider: 'cloudflare', failure: 'transient', error: 'E_INTERNAL' }) });
  assert.ok((await gov.sendTransactional(msg('a@gmail.com'))).ok);
  assert.equal(rs.sent.length, 1);
  assert.equal(capacity.counts.get('cloudflare|day|2026-10-01|all'), 0);
});

test('a provider that THROWS is treated as an error, not a crash', async () => {
  const { gov, rs } = setup({ cfAnswer: () => { throw new Error('socket hang up'); } });
  assert.ok((await gov.sendTransactional(msg('a@gmail.com'))).ok);
  assert.equal(rs.sent.length, 1);
});

test('a rejected MESSAGE is not retried on the fallback (no double send)', async () => {
  const { gov, rs } = setup({ cfAnswer: () => ({ ok: false, provider: 'cloudflare', failure: 'rejected', error: 'E_CONTENT_TOO_LARGE' }) });
  const r = await gov.sendTransactional(msg('a@gmail.com'));
  assert.equal(r.ok, false);
  assert.equal(rs.sent.length, 0);
});

test('every provider full: a clear capacity failure, nothing sent, nothing counted', async () => {
  const { gov, cf, rs, ledger } = setup({ cfDaily: 1, rsDaily: 1 });
  assert.ok((await gov.sendTransactional(msg('a@gmail.com'))).ok);
  assert.ok((await gov.sendTransactional(msg('b@gmail.com'))).ok);
  const r = await gov.sendTransactional(msg('c@gmail.com'));
  assert.equal(r.ok, false);
  assert.equal((r as any).limited, 'capacity');
  assert.equal(cf.sent.length + rs.sent.length, 2);
  assert.equal(ledger.length, 2);
});

test('signup may use only ~40% of each provider\'s daily limit; sign-in codes keep the rest', async () => {
  // Cloudflare 10/day -> 4 signup; Resend 100/day -> 40 signup.
  const { gov, cf, rs } = setup({ rsDaily: 10 });
  let signupOk = 0;
  for (let i = 0; i < 12; i++) if ((await gov.sendTransactional(msg('s' + i + '@gmail.com', 'signup'))).ok) signupOk++;
  assert.equal(signupOk, 8, '4 on each provider');
  const blocked = await gov.sendTransactional(msg('late@gmail.com', 'signup'));
  assert.equal((blocked as any).limited, 'signup_share');
  assert.equal(await gov.hasRoom('signup', 'x@gmail.com'), false, 'the route can ask before taking a name');
  assert.equal(await gov.hasRoom('standard', 'x@gmail.com'), true);
  let codes = 0;
  for (let i = 0; i < 12; i++) if ((await gov.sendTransactional(msg('c' + i + '@gmail.com'))).ok) codes++;
  assert.equal(codes, 12, 'the 12 remaining slots (6 + 6) all went to other mail');
  assert.equal(cf.sent.length + rs.sent.length, 20);
});

test('the Cloudflare driver: binding shape, named sender, and how its errors are read', async () => {
  const calls: any[] = [];
  const binding = { async send(m: any) { calls.push(m); if (m.to === 'full@x.com') { const e: any = new Error('Daily sending quota reached'); e.code = 'E_DAILY_LIMIT_EXCEEDED'; throw e; } return { messageId: 'm1' }; } };
  const d = new CloudflareEmailDriver(binding, 'Platform <notifications@platform.example>');
  const ok = await d.sendTransactional({ to: 'a@x.com', from: 'Store A <notifications@platform.example>', replyTo: 'owner@a.com', subject: 's', html: 'h' });
  assert.deepEqual(ok, { ok: true, id: 'm1', provider: 'cloudflare' });
  assert.deepEqual(calls[0].from, { email: 'notifications@platform.example', name: 'Store A' });
  assert.equal(calls[0].replyTo, 'owner@a.com');
  const full = await d.sendTransactional({ to: 'full@x.com', from: '', subject: 's', html: 'h' });
  assert.equal((full as any).failure, 'full');
  assert.equal(new CloudflareEmailDriver(null, 'x@y.z').configured, false, 'no binding (not on Workers Paid yet): unconfigured, so skipped');
  assert.equal(cloudflareFailureKind('E_RATE_LIMIT_EXCEEDED'), 'transient');
  assert.equal(cloudflareFailureKind('E_SENDER_DOMAIN_NOT_AVAILABLE'), 'transient');
  assert.equal(cloudflareFailureKind('E_TOO_MANY_RECIPIENTS'), 'rejected');
  assert.deepEqual(parseFrom('a@b.c'), 'a@b.c');
});

test('Resend failures are classified the same way', () => {
  assert.equal(resendFailureKind(429, '{"name":"daily_quota_exceeded"}'), 'full');
  assert.equal(resendFailureKind(429, '{"name":"monthly_quota_exceeded"}'), 'full');
  assert.equal(resendFailureKind(429, '{"name":"rate_limit_exceeded"}'), 'transient');
  assert.equal(resendFailureKind(422, '{"name":"validation_error"}'), 'rejected');
  assert.equal(resendFailureKind(500, ''), 'transient');
  assert.equal(resendFailureKind(403, 'domain not verified'), 'transient');
});

test('operator alerts bypass a full counter, within their own small daily budget (owner, 2026-10-02)', async () => {
  const { gov, capacity, rs, cf } = setup({ cfDaily: 1, rsDaily: 1 });
  // Use up both providers' daily allowance with ordinary mail.
  assert.ok((await gov.sendTransactional(msg('a@real.io'))).ok);
  assert.ok((await gov.sendTransactional(msg('b@real.io'))).ok);
  assert.equal((await gov.sendTransactional(msg('c@real.io'))).ok, false, 'ordinary mail is stopped by the counter');
  // Same governor, now with an alert budget of 2.
  const taken = new Map<string, number>();
  const withBudget = new GovernedEmailDriver({ ...(gov as any).o, alertBudget: { perDay: 2, take: async (day: string, perDay: number) => { const n = (taken.get(day) || 0) + 1; taken.set(day, n); return n <= perDay; } } });
  const alert = (s: string) => withBudget.sendTransactional({ to: 'ops@real.io', from: '', subject: s, html: '<p>x</p>', meta: { category: 'operator_alert' } });
  const before = new Map(capacity.counts);
  assert.ok((await alert('one')).ok, 'an alert goes out although the allowance is used');
  assert.ok((await alert('two')).ok);
  const third = await alert('three');
  assert.equal(third.ok, false, 'the third alert of the day is over the budget');
  assert.deepEqual(capacity.counts, before, 'alerts never touch the capacity counter');
  assert.equal([...cf.sent, ...rs.sent].filter((m) => m.meta?.category === 'operator_alert').length, 2);
  assert.equal((await withBudget.sendTransactional(msg('d@real.io'))).ok, false, 'ordinary mail still respects the counter');
});

test('a budget store that throws counts as no room (the factory store falls back per isolate instead of throwing)', async () => {
  const { gov } = setup();
  const g = new GovernedEmailDriver({ ...(gov as any).o, alertBudget: { perDay: 5, take: async () => { throw new Error('down'); } } });
  const r = await g.sendTransactional({ to: 'ops@real.io', from: '', subject: 's', html: '<p>x</p>', meta: { category: 'operator_alert' } });
  assert.equal(r.ok, false, 'the factory\'s store never throws (it falls back per isolate); a raw throw is refused');
});
