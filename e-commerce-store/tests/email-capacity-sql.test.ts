import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// 00042 in a REAL Postgres: the counts that stand between us and a provider's cap.
const mig = (n: string) => readFileSync(join(import.meta.dirname, '..', 'supabase', 'migrations', n), 'utf8');
let db: PGlite;
const reserve = async (p: string, daily: number | null, monthly: number | null, cat = 'standard', catDaily: number | null = null, day = '2026-10-01', month = '2026-10') =>
  (await db.query<any>('select email_reserve($1, $2, $3, $4, $5, $6, $7) as r', [p, day, month, daily, monthly, cat, catDaily])).rows[0].r;
const count = async (p: string, period: string, key: string, cat = 'all') =>
  Number((await db.query<any>('select sent from email_send_counts where provider = $1 and period = $2 and period_key = $3 and category = $4', [p, period, key, cat])).rows[0]?.sent ?? 0);

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.provider_rates (id uuid primary key default gen_random_uuid(), provider text not null, unit text not null,
      unit_cost_micros bigint not null, included_units bigint not null default 0, period text not null default 'month',
      source_url text, effective_from timestamptz not null default now(), effective_to timestamptz, notes text);
    create table public.usage_events (id uuid primary key default gen_random_uuid(), unit text);
    create table public.platform_policies (key text primary key, value jsonb not null, description text not null default '');
  `);
  await db.exec(mig('00042_email_capacity.sql'));
});

test('limits are data: Resend free is 100/day and 3,000/month; signup share 40%', async () => {
  const r = (await db.query<any>("select daily_limit, monthly_limit, active from email_provider_plans where provider = 'resend' and plan = 'free'")).rows[0];
  assert.deepEqual([r.daily_limit, r.monthly_limit, r.active], [100, 3000, true]);
  const cf = (await db.query<any>("select active from email_provider_plans where provider = 'cloudflare'")).rows[0];
  assert.equal(cf.active, false, 'Cloudflare stays off until Workers Paid');
  assert.equal((await db.query<any>("select value from platform_policies where key = 'email.signup_daily_share_percent'")).rows[0].value, 40);
  const rate = (await db.query<any>("select unit_cost_micros from provider_rates where provider = 'cloudflare' and unit = 'email'")).rows[0];
  assert.equal(Number(rate.unit_cost_micros) * 1000 / 1e6 / 100, 0.35, '$0.35 per 1,000');
  await assert.rejects(db.query("insert into email_provider_plans (provider, plan, active) values ('resend', 'other', true)"), /duplicate|unique/, 'one active plan per provider');
});

test('the daily limit stops at exactly the limit, and counts day and month', async () => {
  const got = [];
  for (let i = 0; i < 4; i++) got.push(await reserve('p1', 3, null));
  assert.deepEqual(got, ['ok', 'ok', 'ok', 'daily']);
  assert.equal(await count('p1', 'day', '2026-10-01'), 3);
  assert.equal(await count('p1', 'month', '2026-10'), 3);
  assert.equal(await reserve('p1', 3, null, 'standard', null, '2026-10-02'), 'ok', 'a new day starts fresh');
});

test('the monthly limit holds across days', async () => {
  assert.equal(await reserve('p2', null, 2, 'standard', null, '2026-10-01'), 'ok');
  assert.equal(await reserve('p2', null, 2, 'standard', null, '2026-10-02'), 'ok');
  assert.equal(await reserve('p2', null, 2, 'standard', null, '2026-10-03'), 'monthly');
});

test('signup has its own share; when it is spent, other mail still goes', async () => {
  assert.equal(await reserve('p3', 10, null, 'signup', 2), 'ok');
  assert.equal(await reserve('p3', 10, null, 'signup', 2), 'ok');
  assert.equal(await reserve('p3', 10, null, 'signup', 2), 'category');
  assert.equal(await reserve('p3', 10, null, 'standard'), 'ok', 'a sign-in code is not blocked by signup');
  assert.equal(await count('p3', 'day', '2026-10-01'), 3, 'the refused signup took nothing');
});

test('release gives a slot back (never below zero); mark-full stops the day', async () => {
  assert.equal(await reserve('p4', 1, null, 'signup', 1), 'ok');
  await db.query("select email_release('p4', '2026-10-01', '2026-10', 'signup')");
  assert.equal(await count('p4', 'day', '2026-10-01'), 0);
  assert.equal(await count('p4', 'day', '2026-10-01', 'signup'), 0);
  await db.query("select email_release('p4', '2026-10-01', '2026-10', 'signup')");
  assert.equal(await count('p4', 'day', '2026-10-01'), 0, 'not below zero');
  await db.query("select email_mark_full('p4', '2026-10-01')");
  assert.equal(await reserve('p4', 100, null), 'daily', 'the provider said full: no more today');
  assert.equal(await reserve('p4', 100, null, 'standard', null, '2026-10-02'), 'ok', 'tomorrow it is asked again');
});

test('fifty concurrent reserves against a limit of 20: exactly 20 succeed', async () => {
  const all = await Promise.all(Array.from({ length: 50 }, () => reserve('p5', 20, null)));
  assert.equal(all.filter((r) => r === 'ok').length, 20);
  assert.equal(await count('p5', 'day', '2026-10-01'), 20);
});
