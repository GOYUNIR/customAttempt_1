-- 00037: stock HOLDS and stock MOVEMENTS (STRATEGY.md §9: "a merchant can set
-- stock" + "inventory reservation holds", designed together, owner-approved
-- 2026-09-27).
--
-- The model:
--   on hand     inventory_levels.quantity_available: units not yet sold.
--   holds       stock_holds: units set aside for an open checkout (30 min) or a
--               drawn raffle winner (until charged or declined).
--   sellable    on hand - active, unexpired holds (stock_levels view).
--   movements   stock_movements: every change to on hand, append-only, with
--               the level after it, who/what did it, and any shortfall.
--
-- Every change goes through ONE function below, which locks the inventory
-- row(s) and writes the movement in the same transaction: a recount can
-- never lose a concurrent sale, two buyers can never both hold the last unit,
-- and each is ONE call from the Worker (the 50-subrequest ceiling).
--
-- Tenant isolation is enforced HERE, not only in the app: every function
-- takes the tenant and touches a variant only if its inventory row (or, for
-- a first count, its product_variants row) belongs to that tenant.
--
-- The functions are callable by the service role only (PostgREST would
-- otherwise expose them to the public anon key). Safe to re-run.

-- ── Holds ────────────────────────────────────────────────────────────────────
create table if not exists public.stock_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  hold_key text not null,
  quantity integer not null check (quantity > 0),
  status text not null default 'active' check (status in ('active', 'converted', 'released')),
  -- null = no expiry (a drawn raffle winner: held until charged or declined)
  expires_at timestamptz,
  reference text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (tenant_id, hold_key, variant_id)
);
create index if not exists stock_holds_active_idx on public.stock_holds (variant_id) where status = 'active';
create index if not exists stock_holds_key_idx on public.stock_holds (tenant_id, hold_key);
alter table public.stock_holds enable row level security;

-- ── Movements (append-only history) ─────────────────────────────────────────
-- No foreign keys on purpose: history outlives a deleted product or store,
-- and an append-only table must never be the target of a cascading
-- UPDATE/DELETE (the 00036 lesson).
create table if not exists public.stock_movements (
  id bigserial primary key,
  tenant_id uuid not null,
  variant_id uuid not null,
  reason text not null check (reason in ('opening', 'sale', 'restock', 'adjust', 'count', 'correction')),
  delta integer not null,
  quantity_after integer not null check (quantity_after >= 0),
  -- a sale paid for more units than were on hand (a hold that expired before
  -- the payment landed): recorded, stock stops at 0, the merchant decides.
  shortfall integer not null default 0 check (shortfall >= 0),
  reference text,
  actor text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists stock_movements_variant_idx on public.stock_movements (tenant_id, variant_id, created_at desc);
-- A sale is applied once per reference (webhook redelivery, retried charge).
create unique index if not exists stock_movements_sale_once
  on public.stock_movements (tenant_id, variant_id, reference) where reason = 'sale' and reference is not null;
create index if not exists stock_movements_shortfall_idx on public.stock_movements (tenant_id) where shortfall > 0;
alter table public.stock_movements enable row level security;

create or replace function public.stock_movements_block_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'stock_movements is append-only — % is not permitted', tg_op;
end $$;
drop trigger if exists stock_movements_no_update on public.stock_movements;
create trigger stock_movements_no_update before update on public.stock_movements
  for each row execute function public.stock_movements_block_mutation();
drop trigger if exists stock_movements_no_delete on public.stock_movements;
create trigger stock_movements_no_delete before delete on public.stock_movements
  for each row execute function public.stock_movements_block_mutation();

-- Opening balance for every existing row, once.
insert into public.stock_movements (tenant_id, variant_id, reason, delta, quantity_after, reference, actor)
select il.tenant_id, il.variant_id, 'opening', il.quantity_available, il.quantity_available, '00037', 'migration'
from public.inventory_levels il
where not exists (select 1 from public.stock_movements m where m.variant_id = il.variant_id);

-- ── Sellable stock ───────────────────────────────────────────────────────────
create or replace view public.stock_levels with (security_invoker = true) as
select il.tenant_id,
       il.variant_id,
       il.quantity_available as on_hand,
       coalesce(h.held, 0)::integer as held,
       greatest(il.quantity_available - coalesce(h.held, 0), 0)::integer as available
from public.inventory_levels il
left join (
  select variant_id, sum(quantity)::integer as held
  from public.stock_holds
  where status = 'active' and (expires_at is null or expires_at > now())
  group by variant_id
) h on h.variant_id = il.variant_id;

-- ── Internal: lock one variant's row for a tenant, tidying expired holds ─────
create or replace function public.stock__lock(p_tenant uuid, p_variant uuid)
returns integer language plpgsql as $$
declare v_on_hand integer;
begin
  select quantity_available into v_on_hand
    from public.inventory_levels
   where variant_id = p_variant and tenant_id = p_tenant
   for update;
  if not found then return null; end if;
  update public.stock_holds set status = 'released', settled_at = now()
   where variant_id = p_variant and status = 'active' and expires_at is not null and expires_at <= now();
  return v_on_hand;
end $$;

create or replace function public.stock__held(p_variant uuid, p_except_key text default null)
returns integer language sql stable as $$
  select coalesce(sum(quantity), 0)::integer from public.stock_holds
   where variant_id = p_variant and status = 'active'
     and (expires_at is null or expires_at > now())
     and (p_except_key is null or hold_key <> p_except_key)
$$;

-- ── Reserve: all items or none ───────────────────────────────────────────────
-- p_items: [{"variant_id": "...", "quantity": n}, ...]. Idempotent per key: a
-- repeat call returns the existing active holds. p_ttl_seconds null = no expiry.
create or replace function public.stock_reserve(
  p_tenant uuid, p_hold_key text, p_items jsonb, p_ttl_seconds integer, p_reference text default null
) returns jsonb language plpgsql as $$
declare
  v_item record; v_on_hand integer; v_avail integer;
  v_expires timestamptz := case when p_ttl_seconds is null then null else now() + make_interval(secs => p_ttl_seconds) end;
begin
  if p_hold_key is null or length(p_hold_key) = 0 then raise exception 'hold key required'; end if;
  if exists (select 1 from public.stock_holds where tenant_id = p_tenant and hold_key = p_hold_key and status = 'converted') then
    return jsonb_build_object('ok', true, 'already', 'converted');
  end if;
  if exists (select 1 from public.stock_holds where tenant_id = p_tenant and hold_key = p_hold_key and status = 'active'
             and (expires_at is null or expires_at > now())) then
    return jsonb_build_object('ok', true, 'already', 'held');
  end if;
  -- Lock every row first, in a fixed order (no deadlock between two carts).
  for v_item in
    select (i->>'variant_id')::uuid as variant_id, sum((i->>'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_items) i group by 1 order by 1
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_quantity', 'variant_id', v_item.variant_id);
    end if;
    v_on_hand := public.stock__lock(p_tenant, v_item.variant_id);
    if v_on_hand is null then
      return jsonb_build_object('ok', false, 'reason', 'no_stock_row', 'variant_id', v_item.variant_id);
    end if;
    v_avail := v_on_hand - public.stock__held(v_item.variant_id, p_hold_key);
    if v_avail < v_item.quantity then
      return jsonb_build_object('ok', false, 'reason', 'insufficient', 'variant_id', v_item.variant_id, 'available', greatest(v_avail, 0));
    end if;
  end loop;
  -- Everything fits: record the holds (a stale released/expired row for this
  -- key is revived, not duplicated).
  for v_item in
    select (i->>'variant_id')::uuid as variant_id, sum((i->>'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_items) i group by 1 order by 1
  loop
    insert into public.stock_holds (tenant_id, variant_id, hold_key, quantity, status, expires_at, reference)
    values (p_tenant, v_item.variant_id, p_hold_key, v_item.quantity, 'active', v_expires, p_reference)
    on conflict (tenant_id, hold_key, variant_id) do update
      set quantity = excluded.quantity, status = 'active', expires_at = excluded.expires_at,
          reference = excluded.reference, settled_at = null, created_at = now();
  end loop;
  return jsonb_build_object('ok', true, 'expires_at', v_expires);
end $$;

-- ── Release (checkout expired/abandoned, raffle winner declined) ─────────────
create or replace function public.stock_release(p_tenant uuid, p_hold_key text)
returns integer language plpgsql as $$
declare v_rows integer;
begin
  update public.stock_holds set status = 'released', settled_at = now()
   where tenant_id = p_tenant and hold_key = p_hold_key and status = 'active';
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- ── A paid sale ──────────────────────────────────────────────────────────────
-- Decrements on hand once per (variant, reference), converts the key's holds
-- (even expired or released ones: the customer paid). If on hand is short,
-- stock stops at 0 and the shortfall is recorded for the merchant.
create or replace function public.stock_commit_sale(
  p_tenant uuid, p_hold_key text, p_items jsonb, p_reference text
) returns jsonb language plpgsql as $$
declare
  v_item record; v_on_hand integer; v_take integer; v_out jsonb := '[]'::jsonb;
begin
  if p_reference is null or length(p_reference) = 0 then raise exception 'sale reference required'; end if;
  for v_item in
    select (i->>'variant_id')::uuid as variant_id, sum((i->>'quantity')::integer)::integer as quantity
      from jsonb_array_elements(p_items) i group by 1 order by 1
  loop
    v_on_hand := public.stock__lock(p_tenant, v_item.variant_id);
    if v_on_hand is null then
      v_out := v_out || jsonb_build_object('variant_id', v_item.variant_id, 'applied', false, 'reason', 'no_stock_row');
      continue;
    end if;
    if exists (select 1 from public.stock_movements where tenant_id = p_tenant and variant_id = v_item.variant_id
               and reason = 'sale' and reference = p_reference) then
      v_out := v_out || jsonb_build_object('variant_id', v_item.variant_id, 'applied', false, 'reason', 'already', 'remaining', v_on_hand);
      continue;
    end if;
    v_take := least(v_item.quantity, v_on_hand);
    update public.inventory_levels set quantity_available = v_on_hand - v_take, updated_at = now()
     where variant_id = v_item.variant_id and tenant_id = p_tenant;
    insert into public.stock_movements (tenant_id, variant_id, reason, delta, quantity_after, shortfall, reference, actor)
    values (p_tenant, v_item.variant_id, 'sale', -v_take, v_on_hand - v_take, v_item.quantity - v_take, p_reference, 'checkout');
    v_out := v_out || jsonb_build_object('variant_id', v_item.variant_id, 'applied', true,
      'remaining', v_on_hand - v_take, 'shortfall', v_item.quantity - v_take);
  end loop;
  if p_hold_key is not null then
    update public.stock_holds set status = 'converted', settled_at = now()
     where tenant_id = p_tenant and hold_key = p_hold_key and status <> 'converted';
  end if;
  return jsonb_build_object('ok', true, 'items', v_out);
end $$;

-- ── Merchant: relative change (restock +n, damaged -n, correction) ───────────
create or replace function public.stock_adjust(
  p_tenant uuid, p_variant uuid, p_delta integer, p_reason text, p_actor text, p_note text default null
) returns jsonb language plpgsql as $$
declare v_on_hand integer;
begin
  if p_reason not in ('restock', 'adjust', 'correction') then raise exception 'bad reason %', p_reason; end if;
  if p_delta is null or p_delta = 0 then return jsonb_build_object('ok', false, 'reason', 'no_change'); end if;
  v_on_hand := public.stock__lock(p_tenant, p_variant);
  if v_on_hand is null then return jsonb_build_object('ok', false, 'reason', 'no_stock_row'); end if;
  if v_on_hand + p_delta < 0 then
    return jsonb_build_object('ok', false, 'reason', 'below_zero', 'on_hand', v_on_hand);
  end if;
  update public.inventory_levels set quantity_available = v_on_hand + p_delta, updated_at = now()
   where variant_id = p_variant and tenant_id = p_tenant;
  insert into public.stock_movements (tenant_id, variant_id, reason, delta, quantity_after, actor, note)
  values (p_tenant, p_variant, p_reason, p_delta, v_on_hand + p_delta, p_actor, p_note);
  return jsonb_build_object('ok', true, 'before', v_on_hand, 'on_hand', v_on_hand + p_delta,
    'held', public.stock__held(p_variant));
end $$;

-- ── Merchant: a physical count ("there are N on the shelf") ──────────────────
-- Units held by open checkouts are still on the shelf, so N is on hand; what
-- can be sold is N minus the holds. Creates the row for a first count, but
-- only for a variant of THIS tenant.
create or replace function public.stock_set(
  p_tenant uuid, p_variant uuid, p_count integer, p_actor text, p_note text default null
) returns jsonb language plpgsql as $$
declare v_on_hand integer;
begin
  if p_count is null or p_count < 0 then return jsonb_build_object('ok', false, 'reason', 'bad_count'); end if;
  v_on_hand := public.stock__lock(p_tenant, p_variant);
  if v_on_hand is null then
    if not exists (select 1 from public.product_variants where id = p_variant and tenant_id = p_tenant) then
      return jsonb_build_object('ok', false, 'reason', 'no_stock_row');
    end if;
    insert into public.inventory_levels (tenant_id, variant_id, quantity_available)
    values (p_tenant, p_variant, p_count)
    on conflict (variant_id) do nothing;
    if not found then return jsonb_build_object('ok', false, 'reason', 'retry'); end if;
    insert into public.stock_movements (tenant_id, variant_id, reason, delta, quantity_after, actor, note)
    values (p_tenant, p_variant, 'count', p_count, p_count, p_actor, p_note);
    return jsonb_build_object('ok', true, 'before', 0, 'on_hand', p_count, 'held', 0);
  end if;
  if p_count = v_on_hand then
    return jsonb_build_object('ok', true, 'before', v_on_hand, 'on_hand', v_on_hand, 'held', public.stock__held(p_variant), 'unchanged', true);
  end if;
  update public.inventory_levels set quantity_available = p_count, updated_at = now()
   where variant_id = p_variant and tenant_id = p_tenant;
  insert into public.stock_movements (tenant_id, variant_id, reason, delta, quantity_after, actor, note)
  values (p_tenant, p_variant, 'count', p_count - v_on_hand, p_count, p_actor, p_note);
  return jsonb_build_object('ok', true, 'before', v_on_hand, 'on_hand', p_count, 'held', public.stock__held(p_variant));
end $$;

-- ── Server-only ──────────────────────────────────────────────────────────────
revoke all on public.stock_holds, public.stock_movements, public.stock_levels from anon, authenticated;
revoke execute on function public.stock__lock(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.stock__held(uuid, text) from public, anon, authenticated;
revoke execute on function public.stock_reserve(uuid, text, jsonb, integer, text) from public, anon, authenticated;
revoke execute on function public.stock_release(uuid, text) from public, anon, authenticated;
revoke execute on function public.stock_commit_sale(uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.stock_adjust(uuid, uuid, integer, text, text, text) from public, anon, authenticated;
revoke execute on function public.stock_set(uuid, uuid, integer, text, text) from public, anon, authenticated;
grant select, insert, update on public.stock_holds to service_role;
grant select, insert on public.stock_movements to service_role;
grant usage, select on sequence public.stock_movements_id_seq to service_role;
grant select on public.stock_levels to service_role;
grant execute on function public.stock__lock(uuid, uuid) to service_role;
grant execute on function public.stock__held(uuid, text) to service_role;
grant execute on function public.stock_reserve(uuid, text, jsonb, integer, text) to service_role;
grant execute on function public.stock_release(uuid, text) to service_role;
grant execute on function public.stock_commit_sale(uuid, text, jsonb, text) to service_role;
grant execute on function public.stock_adjust(uuid, uuid, integer, text, text, text) to service_role;
grant execute on function public.stock_set(uuid, uuid, integer, text, text) to service_role;
