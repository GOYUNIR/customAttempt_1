-- 00042 — EMAIL CAPACITY: provider limits as data, atomic send counts, a
-- test sink, and per-provider costs. ADDITIVE ONLY.
--
-- Found 2026-10-01: Resend's free plan has a DAILY cap (100) as well as the
-- monthly 3,000, and our headroom check only knew the monthly number; proof
-- runs used the whole day's allowance. Every send now passes the governed
-- driver (services/email/governor.ts), which reserves a slot here first.

-- ── What each provider allows, per plan (changing plans = a data edit) ──────
create table if not exists public.email_provider_plans (
  provider text not null,                 -- 'cloudflare', 'resend', 'sink', …
  plan text not null,                     -- 'free', 'pro', 'workers_paid', …
  daily_limit integer check (daily_limit is null or daily_limit > 0),    -- null = none
  monthly_limit integer check (monthly_limit is null or monthly_limit > 0),
  priority integer not null default 100,  -- lower is tried first
  active boolean not null default false,  -- the plan we are on now
  source_url text,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (provider, plan)
);
create unique index if not exists email_provider_plans_one_active
  on public.email_provider_plans (provider) where active;

insert into public.email_provider_plans (provider, plan, daily_limit, monthly_limit, priority, active, source_url, notes) values
  ('resend', 'free', 100, 3000, 20, true, 'https://resend.com/pricing',
   'Free: 100/day AND 3,000/month, one verified sending domain.'),
  ('resend', 'pro', null, 50000, 20, false, 'https://resend.com/pricing',
   'Pro $20/month: 50,000/month, no daily cap; overage $0.90 per 1,000.'),
  ('cloudflare', 'workers_paid', 100, null, 10, false, 'https://developers.cloudflare.com/email-service/platform/limits/',
   'Email Service (public beta). Needs Workers Paid. 3,000/month included then $0.35 per 1,000 (billed, so no monthly stop). '
   'The daily quota is per account and NOT published: 100 is a conservative placeholder until measured; set it to the real number.'),
  ('sink', 'test', 100, null, 0, true, null,
   'The recording sink for reserved test domains and simulations. Never real mail; the limit lets proofs exercise the caps.')
on conflict (provider, plan) do nothing;

-- ── How many were sent, per provider, per day and month (atomic) ────────────
create table if not exists public.email_send_counts (
  provider text not null,
  period text not null check (period in ('day', 'month')),
  period_key text not null,               -- '2026-10-01' or '2026-10' (UTC)
  category text not null default 'all',   -- 'all', 'signup', or '_full'
  sent integer not null default 0 check (sent >= 0),
  updated_at timestamptz not null default now(),
  primary key (provider, period, period_key, category)
);

-- Take one slot. Returns 'ok', or which limit stopped it. Rows are locked in
-- a fixed order (day, month, category) so concurrent sends cannot both take
-- the last slot.
create or replace function public.email_reserve(
  p_provider text, p_day text, p_month text, p_daily int, p_monthly int,
  p_category text, p_category_daily int
) returns text language plpgsql security definer set search_path = public as $$
declare d int; m int; c int; f int;
begin
  insert into email_send_counts (provider, period, period_key, category) values
    (p_provider, 'day', p_day, 'all'), (p_provider, 'month', p_month, 'all')
  on conflict do nothing;
  select sent into f from email_send_counts where provider = p_provider and period = 'day' and period_key = p_day and category = '_full';
  if coalesce(f, 0) > 0 then return 'daily'; end if;
  select sent into d from email_send_counts where provider = p_provider and period = 'day' and period_key = p_day and category = 'all' for update;
  select sent into m from email_send_counts where provider = p_provider and period = 'month' and period_key = p_month and category = 'all' for update;
  if p_daily is not null and d >= p_daily then return 'daily'; end if;
  if p_monthly is not null and m >= p_monthly then return 'monthly'; end if;
  if p_category is not null and p_category not in ('all', 'standard') and p_category_daily is not null then
    insert into email_send_counts (provider, period, period_key, category) values (p_provider, 'day', p_day, p_category) on conflict do nothing;
    select sent into c from email_send_counts where provider = p_provider and period = 'day' and period_key = p_day and category = p_category for update;
    if c >= p_category_daily then return 'category'; end if;
    update email_send_counts set sent = sent + 1, updated_at = now() where provider = p_provider and period = 'day' and period_key = p_day and category = p_category;
  end if;
  update email_send_counts set sent = sent + 1, updated_at = now()
   where provider = p_provider and category = 'all' and ((period = 'day' and period_key = p_day) or (period = 'month' and period_key = p_month));
  return 'ok';
end $$;

-- Give back a slot for a send that did not happen.
create or replace function public.email_release(p_provider text, p_day text, p_month text, p_category text)
returns void language sql security definer set search_path = public as $$
  update email_send_counts set sent = greatest(sent - 1, 0), updated_at = now()
   where provider = p_provider and (
     (category = 'all' and ((period = 'day' and period_key = p_day) or (period = 'month' and period_key = p_month)))
     or (period = 'day' and period_key = p_day and category = p_category and p_category not in ('all', 'standard', '_full')));
$$;

-- The provider said it is full today.
create or replace function public.email_mark_full(p_provider text, p_day text)
returns void language sql security definer set search_path = public as $$
  insert into email_send_counts (provider, period, period_key, category, sent) values (p_provider, 'day', p_day, '_full', 1)
  on conflict (provider, period, period_key, category) do update set sent = 1, updated_at = now();
$$;

-- ── The sink: what proofs and simulations "sent" (never real mail) ──────────
create table if not exists public.email_sink (
  id uuid primary key default gen_random_uuid(),
  to_address text not null,
  from_address text,
  reply_to text,
  subject text not null,
  html text,
  text_body text,
  category text,
  tenant_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists email_sink_to_idx on public.email_sink (lower(to_address), created_at desc);
create index if not exists email_sink_created_idx on public.email_sink (created_at);

-- ── Cost per provider ───────────────────────────────────────────────────────
alter table public.usage_events add column if not exists provider text;

-- $0.35 per 1,000 = 0.035 cents each = 35,000 millionths of a cent.
insert into public.provider_rates (provider, unit, unit_cost_micros, included_units, period, source_url, notes)
select 'cloudflare', 'email', 35000, 3000, 'month', 'https://developers.cloudflare.com/email-service/platform/pricing/',
       'Email Service on Workers Paid: 3,000/month included per account, then $0.35 per 1,000. Sends to verified destination addresses are free.'
where not exists (select 1 from public.provider_rates where provider = 'cloudflare' and unit = 'email');
insert into public.provider_rates (provider, unit, unit_cost_micros, included_units, period, source_url, notes)
select 'sink', 'email', 0, 0, 'month', null, 'The test sink: never sent, costs nothing.'
where not exists (select 1 from public.provider_rates where provider = 'sink' and unit = 'email');

-- ── Signup's share of each provider's daily limit ───────────────────────────
insert into public.platform_policies (key, value, description) values
  ('email.signup_daily_share_percent', '40'::jsonb,
   'Signup mail may use at most this percent of each provider''s daily limit; sign-in codes, orders, winners and alerts keep the rest.')
on conflict (key) do nothing;

-- ── Access: the server (service role) only ──────────────────────────────────
alter table public.email_provider_plans enable row level security;
alter table public.email_send_counts enable row level security;
alter table public.email_sink enable row level security;
revoke all on public.email_provider_plans, public.email_send_counts, public.email_sink from anon, authenticated;
grant select, insert, update on public.email_provider_plans to service_role;
grant select on public.email_send_counts to service_role;
grant select, insert, delete on public.email_sink to service_role;
revoke all on function public.email_reserve(text, text, text, int, int, text, int) from public, anon, authenticated;
revoke all on function public.email_release(text, text, text, text) from public, anon, authenticated;
revoke all on function public.email_mark_full(text, text) from public, anon, authenticated;
grant execute on function public.email_reserve(text, text, text, int, int, text, int) to service_role;
grant execute on function public.email_release(text, text, text, text) to service_role;
grant execute on function public.email_mark_full(text, text) to service_role;
