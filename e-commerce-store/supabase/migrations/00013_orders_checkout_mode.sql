-- =============================================================================
-- 00013_orders_checkout_mode.sql — a real `checkout_mode` column on `orders`.
--
-- 00012_drop_mode_schema.sql already gives raffle/FCFS/waitlist/shared-pool a
-- full relational home at the variant+entry level (product_variants.checkout_
-- mode, raffle_entries, drop_draws, waitlist_entries, shared_inventory_pools).
-- The one remaining gap: `orders` itself only carries checkoutMode inside its
-- opaque `metadata` jsonb (00011) — not a real, indexable column. This closes
-- that gap for orders written going forward and backfills what's already
-- there from the jsonb.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00013_orders_checkout_mode.sql
-- =============================================================================

alter table public.orders
  add column if not exists checkout_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_checkout_mode_check'
  ) then
    alter table public.orders
      add constraint orders_checkout_mode_check
      check (checkout_mode is null or checkout_mode in ('fcfs', 'raffle', 'waitlist', 'rfq_quote'));
  end if;
end $$;

update public.orders
set checkout_mode = lower(metadata->>'checkoutMode')
where checkout_mode is null
  and metadata ? 'checkoutMode'
  and lower(metadata->>'checkoutMode') in ('fcfs', 'raffle', 'waitlist', 'rfq_quote');

create index if not exists orders_tenant_checkout_mode_idx on public.orders (tenant_id, checkout_mode);
