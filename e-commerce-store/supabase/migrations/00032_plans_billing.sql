-- ─────────────────────────────────────────────────────────────────────────────
-- 00032 — plans become the pricing contract; tenants get a plan; every charge
-- is recorded for the graduated platform fee.
--
-- Design: PRICING.md. Decisions D1–D5 made by the owner on 2026-09-24.
-- The live schema was probed before this was written (plans existed and was
-- EMPTY; none of the columns, tables or functions below existed) — the check
-- 00029 skipped and paid for.
--
-- WHAT THIS DOES
--   1. plans gains the fee terms, and is seeded with the four plans.
--   2. tenants.plan_id — every tenant is on a plan, 'free' by default.
--   3. tenant_billing_charges — one row per successful charge, keyed by its
--      PaymentIntent, which is what makes the running monthly total
--      idempotent: a retried webhook records nothing twice.
--   4. Functions that advance and read the monthly total in ONE statement.
--   5. orders.platform_fee_cents — what the platform took on each sale.
--
-- NOTHING HERE CHARGES ANYONE. The fee is collected through Stripe Connect,
-- which does not exist yet; until then these rows are the contract and the
-- ledger that Connect will write to.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Plans: the fee terms ──────────────────────────────────────────────────

alter table public.plans
  -- Platform fee per sale, basis points (200 = 2%). NULL = negotiated (Scale).
  add column if not exists platform_fee_bps integer
    check (platform_fee_bps is null or platform_fee_bps between 0 and 10000),
  -- How a tenant ON this plan pays: 'graduated' pays the envelope (PRICING.md
  -- §3), 'flat' pays base price + platform_fee_bps, 'custom' is a contract.
  add column if not exists fee_mode text not null default 'flat'
    check (fee_mode in ('graduated', 'flat', 'custom')),
  -- Whether this plan's cost line is one of the lines the graduated envelope
  -- is the minimum of. EXPLICIT, never inferred from the price: Scale is
  -- stored with base_price_cents = 0 (the column is NOT NULL and its real
  -- price lives in a contract), and a $0, 0% line in the envelope would make
  -- every graduated merchant's fee zero.
  add column if not exists in_fee_envelope boolean not null default false,
  -- Whether the plan is offered for sale. D2: Starter is not sold, but its
  -- rate stays the middle band of the graduated schedule.
  add column if not exists listed boolean not null default true,
  add column if not exists sort_order integer not null default 0;

-- A line in the envelope must have a rate; a graduated plan must be in it.
alter table public.plans drop constraint if exists plans_envelope_has_rate;
alter table public.plans add constraint plans_envelope_has_rate
  check (not in_fee_envelope or platform_fee_bps is not null);
alter table public.plans drop constraint if exists plans_graduated_in_envelope;
alter table public.plans add constraint plans_graduated_in_envelope
  check (fee_mode <> 'graduated' or in_fee_envelope);

-- Seed. Mirrors lib/platform-marketing.ts, which `npm run verify:plans`
-- checks against these rows.
--
-- included_modules follows the existing copy: failed-payment recovery on
-- every plan; cart and back-in-stock recovery on Growth; speed_to_lead on no
-- plan (STRATEGY §7: our own sales team first, sold only once it earns it).
--
-- D1: no order cap on Free. `monitored_orders_per_month` is an ABUSE-REVIEW
-- threshold, not a plan limit: crossing it raises an alert for a human to
-- look at; it never blocks a merchant's sale on its own. Blocking a paying
-- merchant's checkout automatically is a customer-harming action, and at 2%
-- a Free merchant pays for their own transactional email many times over.
insert into public.plans
  (id, name, base_price_cents, platform_fee_bps, fee_mode, in_fee_envelope, listed, sort_order,
   allowances, included_modules)
values
  ('free',    'Free',    0,    200,  'graduated', true,  true,  10,
   '{"monitored_orders_per_month": 1000}'::jsonb, array['dunning']),
  ('starter', 'Starter', 2900, 50,   'flat',      true,  false, 20,
   '{}'::jsonb, array['dunning']),
  ('growth',  'Growth',  9900, 0,    'flat',      true,  true,  30,
   '{}'::jsonb, array['dunning', 'cart_recovery', 'back_in_stock']),
  ('scale',   'Scale',   0,    null, 'custom',    false, true,  40,
   '{}'::jsonb, array['dunning', 'cart_recovery', 'back_in_stock'])
on conflict (id) do update set
  name = excluded.name,
  base_price_cents = excluded.base_price_cents,
  platform_fee_bps = excluded.platform_fee_bps,
  fee_mode = excluded.fee_mode,
  in_fee_envelope = excluded.in_fee_envelope,
  listed = excluded.listed,
  sort_order = excluded.sort_order,
  allowances = excluded.allowances,
  included_modules = excluded.included_modules;

-- ── 2. Every tenant is on a plan ─────────────────────────────────────────────
-- After the seed, so the default has a row to reference. Existing tenants take
-- the default: 'free', which is where every merchant starts.
alter table public.tenants
  add column if not exists plan_id text not null default 'free'
    references public.plans (id) on update cascade;
create index if not exists tenants_plan_idx on public.tenants (plan_id);

-- ── 3. One row per successful charge ─────────────────────────────────────────
create table if not exists public.tenant_billing_charges (
  -- The PaymentIntent IS the idempotency key: a charge is recorded once,
  -- however many times its webhook is delivered.
  payment_intent_id text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- D4: calendar month, UTC. Stored as the month's first day.
  -- (Not date_trunc: on a date it promotes to timestamptz and the check would
  -- quietly depend on the session timezone.)
  billing_month date not null
    check (extract(day from billing_month) = 1),
  volume_cents bigint not null check (volume_cents >= 0),
  fee_cents bigint not null check (fee_cents >= 0),
  -- D5: a refund returns exactly the fee THAT sale paid and takes its amount
  -- off the month's volume; other sales are never re-rated. Stored as running
  -- totals copied from Stripe (amount refunded, application fee refunded), so
  -- applying the same refund event twice changes nothing.
  refunded_volume_cents bigint not null default 0,
  refunded_fee_cents bigint not null default 0,
  order_id uuid references public.orders (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (refunded_volume_cents between 0 and volume_cents),
  check (refunded_fee_cents between 0 and fee_cents)
);
create index if not exists tenant_billing_charges_month_idx
  on public.tenant_billing_charges (tenant_id, billing_month);

drop trigger if exists tenant_billing_charges_set_updated_at on public.tenant_billing_charges;
create trigger tenant_billing_charges_set_updated_at
  before update on public.tenant_billing_charges
  for each row execute function public.set_updated_at();

alter table public.tenant_billing_charges enable row level security;
-- A merchant may read their own charges (the milestone card); only the
-- platform writes them.
drop policy if exists "tenant_billing_charges_read" on public.tenant_billing_charges;
create policy "tenant_billing_charges_read" on public.tenant_billing_charges
  for select using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());
drop policy if exists "tenant_billing_charges_write" on public.tenant_billing_charges;
create policy "tenant_billing_charges_write" on public.tenant_billing_charges
  for all using (public.current_user_is_super_admin())
  with check (public.current_user_is_super_admin());

-- ── 4. The running total, in one statement ───────────────────────────────────

-- The month's net volume: what graduation is computed from.
create or replace function public.billing_month_volume(p_tenant uuid, p_month date)
returns bigint
language sql stable
as $$
  select coalesce(sum(volume_cents - refunded_volume_cents), 0)::bigint
  from public.tenant_billing_charges
  where tenant_id = p_tenant and billing_month = p_month
$$;

-- Record a successful charge. Returns whether THIS call recorded it (false on
-- a redelivery) and the month's volume afterwards. The insert decides, by the
-- primary key — no read-then-write in application code, which is the lost-
-- update pattern 00031 removed from the webhook dedupe.
create or replace function public.record_billing_charge(
  p_payment_intent text, p_tenant uuid, p_month date,
  p_volume_cents bigint, p_fee_cents bigint, p_order uuid default null
)
returns table (recorded boolean, month_volume bigint)
language plpgsql
as $$
declare
  v_rows integer;
begin
  insert into public.tenant_billing_charges
    (payment_intent_id, tenant_id, billing_month, volume_cents, fee_cents, order_id)
  values (p_payment_intent, p_tenant, p_month, p_volume_cents, p_fee_cents, p_order)
  on conflict (payment_intent_id) do nothing;
  get diagnostics v_rows = row_count;
  return query select v_rows = 1, public.billing_month_volume(p_tenant, p_month);
end
$$;

-- Apply a refund as Stripe's cumulative totals (D5). SETS rather than adds,
-- so a redelivered refund event is harmless. Returns false if the charge was
-- never recorded — the caller must treat that as a reconciliation item, not
-- silently ignore it.
create or replace function public.set_billing_refund(
  p_payment_intent text, p_refunded_volume_cents bigint, p_refunded_fee_cents bigint
)
returns boolean
language plpgsql
as $$
declare
  v_rows integer;
begin
  update public.tenant_billing_charges
     set refunded_volume_cents = p_refunded_volume_cents,
         refunded_fee_cents = p_refunded_fee_cents
   where payment_intent_id = p_payment_intent;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, and PostgREST
-- exposes public-schema functions as /rpc endpoints. These run as the caller
-- (RLS still applies), but billing writes are server-only: nobody but the
-- service role gets to call them at all.
revoke execute on function public.billing_month_volume(uuid, date) from public, anon, authenticated;
revoke execute on function public.record_billing_charge(text, uuid, date, bigint, bigint, uuid) from public, anon, authenticated;
revoke execute on function public.set_billing_refund(text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.billing_month_volume(uuid, date) to service_role;
grant execute on function public.record_billing_charge(text, uuid, date, bigint, bigint, uuid) to service_role;
grant execute on function public.set_billing_refund(text, bigint, bigint) to service_role;

-- ── 5. What the platform took on each sale ───────────────────────────────────
alter table public.orders
  add column if not exists platform_fee_cents integer
    check (platform_fee_cents is null or platform_fee_cents >= 0);
