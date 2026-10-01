-- 00043 — ORDER FULFILMENT (v1: whole order) and REFUND STATUS on orders.
-- ADDITIVE ONLY.
--
-- Shipping is its own row, not columns the order writer can touch: the order
-- writer (lib/order-write.ts) is the only thing that writes `orders`, and a
-- webhook retry must never undo a shipment. One row per order (whole-order
-- fulfilment in v1); the unique order_id makes "mark shipped" idempotent.

create table if not exists public.order_fulfilments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null unique references public.orders (id) on delete cascade,
  carrier text not null check (length(carrier) between 1 and 40),
  tracking_number text not null check (length(tracking_number) between 1 and 64),
  tracking_url text check (tracking_url is null or tracking_url ~ '^https://'),
  shipped_at timestamptz not null default now(),
  shipped_by text not null,                       -- who pressed it (email)
  customer_emailed_at timestamptz,                -- set once the "shipped" email went
  created_at timestamptz not null default now()
);
create index if not exists order_fulfilments_tenant_idx on public.order_fulfilments (tenant_id, shipped_at desc);

-- What was refunded (refunds happen in the merchant's own Stripe Dashboard;
-- charge.refunded tells us). payment_status already allows
-- 'partially_refunded' and 'refunded' (00009).
alter table public.orders add column if not exists refunded_cents bigint not null default 0 check (refunded_cents >= 0);
alter table public.orders add column if not exists refunded_at timestamptz;

-- Mark ONE order of ONE store shipped. 'shipped' the first time; 'already'
-- after that (same tracking or not: v1 has no edit); 'not_found' for another
-- store's order or none; 'not_paid' for an order that was never paid or is
-- fully refunded. The order's status becomes 'fulfilled'.
create or replace function public.mark_order_shipped(
  p_tenant uuid, p_order uuid, p_carrier text, p_tracking text, p_tracking_url text, p_by text
) returns text language plpgsql security definer set search_path = public as $$
declare o record; n int;
begin
  select id, payment_status into o from orders where id = p_order and tenant_id = p_tenant for update;
  if not found then return 'not_found'; end if;
  if o.payment_status not in ('paid', 'partially_refunded') then return 'not_paid'; end if;
  insert into order_fulfilments (tenant_id, order_id, carrier, tracking_number, tracking_url, shipped_by)
  values (p_tenant, p_order, p_carrier, p_tracking, p_tracking_url, p_by)
  on conflict (order_id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return 'already'; end if;
  update orders set status = 'fulfilled', updated_at = now() where id = p_order;
  return 'shipped';
end $$;

-- A refund from Stripe (charge.refunded), for ONE store's order by its
-- PaymentIntent. Never lowers what is recorded (events can arrive out of order).
create or replace function public.set_order_refund(p_tenant uuid, p_payment_intent text, p_refunded_cents bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update orders
     set refunded_cents = greatest(refunded_cents, p_refunded_cents),
         refunded_at = coalesce(refunded_at, now()),
         payment_status = case
           when greatest(refunded_cents, p_refunded_cents) >= total_cents and total_cents > 0 then 'refunded'
           when greatest(refunded_cents, p_refunded_cents) > 0 then 'partially_refunded'
           else payment_status end,
         updated_at = now()
   where tenant_id = p_tenant and stripe_payment_intent_id = p_payment_intent;
  get diagnostics n = row_count;
  return n > 0;
end $$;

alter table public.order_fulfilments enable row level security;
revoke all on public.order_fulfilments from anon, authenticated;
grant select, update on public.order_fulfilments to service_role;
revoke all on function public.mark_order_shipped(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.set_order_refund(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.mark_order_shipped(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.set_order_refund(uuid, text, bigint) to service_role;
