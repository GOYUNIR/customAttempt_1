-- 00038: plan billing (PRICING.md §9). ADDITIVE ONLY: one new table and one
-- new nullable column; no existing row or column changes meaning.
--
-- A store pays for a plan (Growth) through a Stripe Billing subscription on
-- the PLATFORM account. The subscription drives tenants.plan_id (which the fee
-- engine already reads). A failed renewal keeps the paid plan for a 7-day
-- grace period (owner, 2026-09-27); plan_grace_until sits on tenants so the
-- fee engine enforces it with the read it already makes (no extra call on the
-- charge path, which runs under a subrequest budget).

create table if not exists public.tenant_subscriptions (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  -- the store as a customer of the PLATFORM's Stripe account
  stripe_customer_id text not null unique,
  stripe_subscription_id text unique,
  plan_id text references public.plans (id),
  status text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.tenant_subscriptions enable row level security;
revoke all on public.tenant_subscriptions from anon, authenticated;
grant select, insert, update on public.tenant_subscriptions to service_role;

-- When set and in the past, the store is billed as Free even though
-- plan_id still names the paid plan (the renewal failed; grace is over).
alter table public.tenants add column if not exists plan_grace_until timestamptz;
