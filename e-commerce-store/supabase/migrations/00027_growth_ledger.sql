-- 00027 — the Growth layer's foundation: what things cost, what we charge,
-- and what we can honestly claim we added.
--
-- Nothing in the Growth layer may ship before this, for a specific reason: a
-- module whose cost-to-serve is invisible is a module that can run at negative
-- margin for a month before anyone notices. At ~$30/month of fixed cost, one
-- heavy tenant is the whole budget.
--
-- FOUR THINGS LIVE HERE, and all four are DATA rather than code, so packaging,
-- rates, and even which provider is in use can change without a deploy:
--
--   provider_rates    what a unit costs us, with its source and the free
--                     allowance it comes with
--   usage_events      every billable unit actually consumed, per tenant, per
--                     module
--   growth_attribution what a module ADDED, measured against a holdout
--   plans / tenant_modules   what we charge, and what each tenant has on
--
-- WHY provider_rates CARRIES A FREE ALLOWANCE. Resend's free tier is 3,000
-- emails a month. One merchant running cart recovery at a modest 2,000
-- orders/month consumes roughly all of it. "We will notice when the bill
-- arrives" is not a plan when the bill arrives as a stopped send.
--
-- WHY BOTH gross AND incremental ARE STORED. Competitors report gross
-- attributed revenue — every sale that touched a campaign, including the
-- customers who would have bought anyway. We report the difference against a
-- holdout, which is a smaller and truer number. Storing only the true one loses
-- a sales conversation; storing only the gross one makes us the thing we are
-- differentiating from. Both, with the method recorded next to them.

-- ── What a unit costs us ─────────────────────────────────────────────────────
create table if not exists public.provider_rates (
  id uuid primary key default gen_random_uuid(),

  provider text not null,                 -- 'resend', 'twilio', 'anthropic', …
  unit text not null,                     -- 'email', 'sms_segment', 'llm_input_token', …

  -- MILLIONTHS OF A CENT (not of a dollar). An email at $0.0009 is 90,000 of
  -- them: 0.09 cents x 1,000,000. Getting this wrong by a factor of 100 is easy
  -- and silent, so the conversion is stated here and asserted in
  -- tests/growth-ledger.test.ts against the published per-1,000 price.
  --
  -- Cents would round an LLM token to zero; floats would drift over millions of
  -- rows. Integers of this size stay exact.
  unit_cost_micros bigint not null check (unit_cost_micros >= 0),

  -- The provider's free allowance per period, if any. This is what makes
  -- "you are at 84% of the free tier" possible BEFORE the sends stop.
  included_units bigint not null default 0 check (included_units >= 0),
  period text not null default 'month' check (period in ('month', 'day', 'once')),

  -- Where this number came from, so a stale rate is auditable rather than
  -- folklore. Every row should have one.
  source_url text,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  notes text,

  created_at timestamptz not null default now()
);

-- The active rate for a unit is the newest row whose window covers now().
create index if not exists provider_rates_lookup_idx
  on public.provider_rates (provider, unit, effective_from desc);

-- ── What was actually consumed ───────────────────────────────────────────────
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  module_id text not null,                -- 'dunning', 'cart_recovery', …
  unit text not null,
  quantity bigint not null default 1 check (quantity >= 0),

  -- Cost priced at the moment of use. Deliberately NOT recomputed later from
  -- provider_rates: when a rate changes, history must keep what it actually
  -- cost, or last quarter's margin silently changes.
  cost_micros bigint not null default 0 check (cost_micros >= 0),

  occurred_at timestamptz not null default now(),
  -- Ties a unit of spend to the thing that caused it (a message id, an order
  -- ref), so a surprising bill can be traced to specific sends.
  reference text
);

create index if not exists usage_events_tenant_period_idx
  on public.usage_events (tenant_id, occurred_at desc);
create index if not exists usage_events_module_idx
  on public.usage_events (module_id, occurred_at desc);

-- ── What a module added ──────────────────────────────────────────────────────
create table if not exists public.growth_attribution (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  module_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,

  treated_count integer not null default 0 check (treated_count >= 0),
  control_count integer not null default 0 check (control_count >= 0),
  treated_revenue_cents bigint not null default 0,
  control_revenue_cents bigint not null default 0,

  -- What a competitor would report: every conversion that touched the module.
  gross_attributed_cents bigint not null default 0,
  -- What we report: the difference against the holdout. CAN BE NEGATIVE — a
  -- module that did nothing, or hurt, must be able to say so. A non-negative
  -- constraint here would quietly turn a failed experiment into a win.
  incremental_cents bigint not null default 0,

  -- How it was measured, stored per row so a methodology change is visible in
  -- history rather than silently rewriting old results.
  methodology text not null default 'holdout_v1',
  holdout_percent numeric(5,2) not null default 0,
  attribution_window_hours integer not null default 72,

  computed_at timestamptz not null default now(),
  unique (tenant_id, module_id, period_start, methodology)
);

create index if not exists growth_attribution_tenant_idx
  on public.growth_attribution (tenant_id, period_start desc);

-- ── What we charge ───────────────────────────────────────────────────────────
create table if not exists public.plans (
  id text primary key,                    -- 'free', 'starter', 'growth'
  name text not null,
  base_price_cents integer not null default 0 check (base_price_cents >= 0),

  -- Included units per period and the price beyond them, both jsonb so
  -- packaging changes without a migration — which is the point.
  allowances jsonb not null default '{}'::jsonb,
  overage_rates jsonb not null default '{}'::jsonb,
  -- Which modules the plan turns on.
  included_modules text[] not null default '{}',

  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── What each tenant has on ──────────────────────────────────────────────────
create table if not exists public.tenant_modules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  module_id text not null,

  enabled boolean not null default false,

  -- Per-tenant overrides of the module's registry defaults. A pivot in
  -- packaging, or one merchant who wants a bigger holdout, is a row edit.
  config jsonb not null default '{}'::jsonb,

  -- The safety valve. A module whose cost scales with usage must not be able to
  -- run a tenant into negative margin unnoticed; the daily cap is enforced
  -- before send, not reconciled after.
  daily_unit_cap bigint,
  paused_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, module_id)
);

create index if not exists tenant_modules_enabled_idx
  on public.tenant_modules (tenant_id, enabled);

-- ── updated_at ───────────────────────────────────────────────────────────────
drop trigger if exists plans_set_updated_at on public.plans;
create trigger plans_set_updated_at before update on public.plans
  for each row execute function public.set_updated_at();

drop trigger if exists tenant_modules_set_updated_at on public.tenant_modules;
create trigger tenant_modules_set_updated_at before update on public.tenant_modules
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Tenant-scoped tables get the standard admin-tier policy. provider_rates and
-- plans are PLATFORM data (our costs, our packaging) — not tenant-scoped, and
-- not readable by a tenant: our cost-to-serve is not a merchant's business.
alter table public.usage_events enable row level security;
alter table public.growth_attribution enable row level security;
alter table public.tenant_modules enable row level security;
alter table public.provider_rates enable row level security;
alter table public.plans enable row level security;

drop policy if exists "usage_events_all" on public.usage_events;
create policy "usage_events_all" on public.usage_events
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "growth_attribution_all" on public.growth_attribution;
create policy "growth_attribution_all" on public.growth_attribution
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "tenant_modules_all" on public.tenant_modules;
create policy "tenant_modules_all" on public.tenant_modules
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "provider_rates_platform" on public.provider_rates;
create policy "provider_rates_platform" on public.provider_rates
  for all using (public.current_user_is_super_admin())
  with check (public.current_user_is_super_admin());

drop policy if exists "plans_platform" on public.plans;
create policy "plans_platform" on public.plans
  for all using (public.current_user_is_super_admin())
  with check (public.current_user_is_super_admin());

-- ── Seed: the rates verified on 2026-09-17 ───────────────────────────────────
-- Seeded as data, with sources, so changing a rate is an UPDATE rather than a
-- deploy. Only the providers actually in use are seeded; SMS and LLM rates are
-- deliberately absent because no module may use them yet (see ARCHITECTURE.md).
insert into public.provider_rates (provider, unit, unit_cost_micros, included_units, period, source_url, notes)
values
  -- Resend free tier: 3,000 emails/month, then $0.90 per 1,000 on the $20 Pro
  -- plan = $0.0009 = 900 micros each.
  ('resend', 'email', 90000, 3000, 'month', 'https://resend.com/pricing',
   'Free tier 3,000/mo. Pro $20/mo = 50,000 then $0.90/1k. ONE merchant running cart recovery at ~2,000 orders/mo consumes the free tier.'),
  -- Cloudflare Workers paid: $5/mo, 10M requests included, $0.30/M after.
  ('cloudflare', 'worker_request', 30, 10000000, 'month', 'https://developers.cloudflare.com/workers/platform/pricing/',
   '$0.30 per additional million = 0.3 micros each; effectively free at our volume.'),
  -- Supabase Pro: $25/mo, 250 GB egress included, $0.09/GB after.
  ('supabase', 'egress_gb', 9000000, 250, 'month', 'https://supabase.com/pricing',
   '$0.09/GB beyond 250 GB included on Pro.')
on conflict do nothing;

comment on table public.provider_rates is
  'What a unit costs us, with its source and free allowance. Rates are DATA so they change without a deploy; included_units is what makes free-tier headroom alerting possible before sends stop.';
comment on column public.usage_events.cost_micros is
  'Priced at the moment of use and never recomputed. If a provider rate changes, history must keep what it actually cost.';
comment on column public.growth_attribution.incremental_cents is
  'Revenue the module ADDED versus its holdout. Deliberately allowed to be negative — a module that did nothing must be able to report that.';
comment on column public.growth_attribution.gross_attributed_cents is
  'What a competitor would report: every conversion that touched the module. Stored alongside the incremental figure so the difference can be shown and explained rather than argued.';
