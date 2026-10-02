-- 00045 — DISCOUNT CODES for merchant stores (DISCOUNT-CODES.md, owner-
-- approved 2026-10-01). ADDITIVE ONLY. Behind a plan flag, OFF on every plan.
--
-- A code is one store's: unique per (tenant, code), looked up by the store
-- the request is for, never by code alone. A use is RESERVED when checkout
-- starts (held, with the checkout's expiry), turned into a redemption by the
-- payment webhook, and released when the checkout expires: so 20 parallel
-- checkouts cannot each pass a "first 10 customers" limit. A refund does not
-- give the use back (owner decision 3).

alter table public.plans add column if not exists discount_codes_enabled boolean not null default false;
alter table public.plans add column if not exists discount_code_limit integer check (discount_code_limit is null or discount_code_limit >= 0);
update public.plans set discount_code_limit = case id when 'free' then 3 when 'starter' then 10 else null end
 where discount_code_limit is null;

create table if not exists public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{4,24}$'),
  kind text not null check (kind in ('percent', 'fixed')),
  percent_bps integer check (percent_bps is null or (percent_bps between 1 and 9000)),   -- 9000 = 90% (decision 7)
  amount_cents bigint check (amount_cents is null or amount_cents > 0),
  currency text,                                   -- fixed codes: the store's currency
  min_subtotal_cents bigint not null default 0 check (min_subtotal_cents >= 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  max_uses_per_customer integer not null default 1 check (max_uses_per_customer > 0),
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  check ((kind = 'percent' and percent_bps is not null and amount_cents is null)
      or (kind = 'fixed' and amount_cents is not null and percent_bps is null and currency is not null))
);
create index if not exists discount_codes_tenant_idx on public.discount_codes (tenant_id, created_at desc);

create table if not exists public.discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  code_id uuid not null references public.discount_codes (id) on delete cascade,
  hold_key text not null,                          -- the checkout attempt (same key as its stock hold)
  email text not null,
  status text not null default 'held' check (status in ('held', 'redeemed', 'released')),
  expires_at timestamptz,                          -- a held use stops counting after this
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  order_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, hold_key)
);
create index if not exists discount_redemptions_code_idx on public.discount_redemptions (code_id, status);

-- Reserve one use of THIS store's code for one checkout attempt. Returns JSON:
-- {result:'ok', code_id, kind, percent_bps, amount_cents, currency} or
-- {result:'invalid'|'minimum', ...}. 'invalid' covers unknown, inactive, not
-- started, expired, used up, per-customer limit and wrong currency alike: the
-- shopper is told one thing, so nobody can probe which codes exist.
create or replace function public.reserve_discount(
  p_tenant uuid, p_code text, p_email text, p_hold_key text, p_subtotal_cents bigint, p_currency text, p_ttl_seconds int
) returns jsonb language plpgsql security definer set search_path = public as $$
declare c record; used int; mine int;
begin
  select * into c from discount_codes where tenant_id = p_tenant and code = upper(p_code) for update;
  if not found or not c.active or c.starts_at > now() or (c.ends_at is not null and c.ends_at <= now()) then
    return jsonb_build_object('result', 'invalid', 'why', 'unavailable');
  end if;
  if c.kind = 'fixed' and lower(c.currency) <> lower(p_currency) then return jsonb_build_object('result', 'invalid', 'why', 'currency'); end if;
  if p_subtotal_cents < c.min_subtotal_cents then return jsonb_build_object('result', 'minimum', 'min_subtotal_cents', c.min_subtotal_cents); end if;
  select count(*) into used from discount_redemptions
   where code_id = c.id and hold_key <> p_hold_key and (status = 'redeemed' or (status = 'held' and (expires_at is null or expires_at > now())));
  if c.max_uses is not null and used >= c.max_uses then return jsonb_build_object('result', 'invalid', 'why', 'used_up'); end if;
  select count(*) into mine from discount_redemptions
   where code_id = c.id and hold_key <> p_hold_key and lower(email) = lower(p_email) and (status = 'redeemed' or (status = 'held' and (expires_at is null or expires_at > now())));
  if mine >= c.max_uses_per_customer then return jsonb_build_object('result', 'invalid', 'why', 'per_customer'); end if;
  insert into discount_redemptions (tenant_id, code_id, hold_key, email, status, expires_at)
  values (p_tenant, c.id, p_hold_key, lower(p_email), 'held', now() + make_interval(secs => p_ttl_seconds))
  on conflict (tenant_id, hold_key) do update set code_id = excluded.code_id, email = excluded.email, status = 'held',
    expires_at = excluded.expires_at, updated_at = now()
  where discount_redemptions.status <> 'redeemed';
  return jsonb_build_object('result', 'ok', 'code_id', c.id, 'code', c.code, 'kind', c.kind, 'percent_bps', c.percent_bps,
    'amount_cents', c.amount_cents, 'currency', c.currency);
end $$;

-- The checkout was paid: the held use becomes a redemption (idempotent; also
-- counts a payment that arrived after the hold lapsed, since money moved).
create or replace function public.redeem_discount(p_tenant uuid, p_hold_key text, p_order_ref text, p_discount_cents bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update discount_redemptions set status = 'redeemed', order_ref = p_order_ref, discount_cents = greatest(0, p_discount_cents), updated_at = now()
   where tenant_id = p_tenant and hold_key = p_hold_key;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- The checkout expired unpaid: give the use back (a redeemed use is untouched).
create or replace function public.release_discount(p_tenant uuid, p_hold_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update discount_redemptions set status = 'released', updated_at = now()
   where tenant_id = p_tenant and hold_key = p_hold_key and status = 'held';
  get diagnostics n = row_count;
  return n > 0;
end $$;

alter table public.discount_codes enable row level security;
alter table public.discount_redemptions enable row level security;
revoke all on public.discount_codes, public.discount_redemptions from anon, authenticated;
grant select, insert, update on public.discount_codes, public.discount_redemptions to service_role;
grant delete on public.discount_codes, public.discount_redemptions to service_role;
revoke all on function public.reserve_discount(uuid, text, text, text, bigint, text, int) from public, anon, authenticated;
revoke all on function public.redeem_discount(uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.release_discount(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_discount(uuid, text, text, text, bigint, text, int) to service_role;
grant execute on function public.redeem_discount(uuid, text, text, bigint) to service_role;
grant execute on function public.release_discount(uuid, text) to service_role;
