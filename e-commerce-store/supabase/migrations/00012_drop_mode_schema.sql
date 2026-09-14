-- =============================================================================
-- 00012_drop_mode_schema.sql — native schema for this store's real selling
-- modes: Raffle, FCFS, Waitlist, and Shared Inventory Pools. Closes the gap
-- lib/postgres-shadow-write.ts's header identified: checkout_mode/entry
-- pools/draws had no relational home in 00009, only opaque `metadata` jsonb.
--
--   product_variants.checkout_mode  — FCFS / RAFFLE / WAITLIST, first-class.
--   shared_inventory_pools          — multiple variants (e.g. the same size
--       synced across two products) drawing from ONE stock count, mirroring
--       lib/checkout-mode.ts's `inventorySyncSlug` concept.
--   raffle_entries                  — a pending entry BEFORE a draw decides
--       it (never charged yet) — the raffle concept 00009's generic `orders`
--       table has no room for (an order is always a confirmed sale).
--   drop_draws                      — one row per executed draw run.
--   waitlist_entries                — FCFS overflow / notify-when-available.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00012_drop_mode_schema.sql
-- =============================================================================

-- ── Checkout mode: first-class on the variant ────────────────────────────────
alter table public.product_variants
  add column if not exists checkout_mode text not null default 'fcfs'
  check (checkout_mode in ('fcfs', 'raffle', 'waitlist'));

create index if not exists product_variants_checkout_mode_idx on public.product_variants (checkout_mode);

-- ── Shared inventory pools ────────────────────────────────────────────────────
create table if not exists public.shared_inventory_pools (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  slug text not null,
  quantity_available integer not null default 0 check (quantity_available >= 0),
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists shared_inventory_pools_tenant_idx on public.shared_inventory_pools (tenant_id);

-- A variant with a non-null shared_pool_id draws its stock from that pool's
-- quantity_available INSTEAD OF its own inventory_levels row (checkout logic
-- checks shared_pool_id first — mirrors lib/checkout-mode.ts's
-- inventorySyncSlug precedence over a size's own inventory).
alter table public.product_variants
  add column if not exists shared_pool_id uuid references public.shared_inventory_pools (id) on delete set null;

create index if not exists product_variants_shared_pool_idx on public.product_variants (shared_pool_id);

-- ── Raffle entries (pending — a draw hasn't decided them yet) ────────────────
create table if not exists public.raffle_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  email text not null,
  -- A Stripe SetupIntent/PaymentMethod reference — NEVER a raw card number.
  payment_method_ref text,
  status text not null default 'pending'
    check (status in ('pending', 'winner', 'not_selected', 'charged', 'declined', 'cancelled')),
  promo_code text,
  discount_percent numeric check (discount_percent is null or (discount_percent >= 0 and discount_percent <= 100)),
  shipping_address text,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists raffle_entries_tenant_idx on public.raffle_entries (tenant_id);
create index if not exists raffle_entries_variant_idx on public.raffle_entries (variant_id);
create index if not exists raffle_entries_status_idx on public.raffle_entries (status);
-- One pending entry per email per variant — mirrors the Redis pool's
-- duplicate-entry block (emailBlockKey in lib/redis-keys.ts).
create unique index if not exists raffle_entries_unique_pending
  on public.raffle_entries (tenant_id, variant_id, email)
  where status = 'pending';

-- ── Drop draws (execution history) ───────────────────────────────────────────
create table if not exists public.drop_draws (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  winner_count integer not null default 0 check (winner_count >= 0),
  entries_count integer not null default 0 check (entries_count >= 0),
  executed_at timestamptz not null default now(),
  -- Per-winner outcome summary (charged/declined/order ids) — queryable
  -- history without a separate winners table for a first cut.
  summary jsonb not null default '{}'::jsonb
);
create index if not exists drop_draws_tenant_idx on public.drop_draws (tenant_id);
create index if not exists drop_draws_variant_idx on public.drop_draws (variant_id);

-- ── Waitlist entries (FCFS overflow / notify-when-available) ────────────────
create table if not exists public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  email text not null,
  status text not null default 'waiting' check (status in ('waiting', 'notified', 'converted', 'expired')),
  created_at timestamptz not null default now(),
  unique (tenant_id, variant_id, email)
);
create index if not exists waitlist_entries_tenant_idx on public.waitlist_entries (tenant_id);
create index if not exists waitlist_entries_variant_idx on public.waitlist_entries (variant_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
drop trigger if exists shared_inventory_pools_set_updated_at on public.shared_inventory_pools;
create trigger shared_inventory_pools_set_updated_at before update on public.shared_inventory_pools
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.shared_inventory_pools enable row level security;
alter table public.raffle_entries enable row level security;
alter table public.drop_draws enable row level security;
alter table public.waitlist_entries enable row level security;

-- Same admin-tier shape as inventory_levels/orders (00009): tenant admins
-- (super_admin / owner / staff of the tenant) manage; nothing here is
-- exposed to the anon/authenticated PostgREST surface directly (the app's
-- own service-role-backed routes are the only writers, same as the rest of
-- this schema).
drop policy if exists "shared_inventory_pools_all" on public.shared_inventory_pools;
create policy "shared_inventory_pools_all" on public.shared_inventory_pools
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "raffle_entries_all" on public.raffle_entries;
create policy "raffle_entries_all" on public.raffle_entries
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "drop_draws_all" on public.drop_draws;
create policy "drop_draws_all" on public.drop_draws
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "waitlist_entries_all" on public.waitlist_entries;
create policy "waitlist_entries_all" on public.waitlist_entries
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());
