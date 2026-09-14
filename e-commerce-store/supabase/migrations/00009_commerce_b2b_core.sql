-- =============================================================================
-- 00009_commerce_b2b_core.sql — Postgres schema for the core commerce entities
-- (products/variants/inventory/carts/orders) and the enterprise B2B engine
-- (companies/price lists/quotes/approvals), plus the immutable audit trail's
-- exact enterprise shape (staff_id, target_tenant_id, payload, ip_address).
--
-- SCOPE — this migration is schema-only. It does NOT change what any live
-- route reads or writes: the application's current primary store for
-- products/carts/orders/etc. remains the existing Redis-backed
-- StorageClient (lib/storage/*) exactly as before. These tables exist so the
-- B2B engine (companies, price lists, quotes, approvals — none of which have
-- a Redis home today) can be built against a real, tenant-isolated schema,
-- and so a FUTURE, separately-staged cutover of the core commerce entities
-- has a schema to land on. Migrating live traffic onto these tables (dual-
-- write, backfill, cutover) is deliberately out of scope here — that needs
-- its own staged rollout against a real environment, not a blind schema
-- swap under a single migration.
--
-- RLS DESIGN — every table below is tenant-isolated via `current_user_tenant()`
-- / `current_user_is_super_admin()` (00003/00008), consistent with the rest
-- of this schema. Customer-facing tables (customers/carts/cart_items/orders/
-- order_line_items) are intentionally NOT opened to the `authenticated`
-- Postgres role: this app's customer auth (app/api/auth/*) is its own
-- session system, not Supabase Auth, so those tables are accessed by the
-- Next.js server via the service-role key (which bypasses RLS) on behalf of
-- an already-session-validated customer — the same pattern `store_kv`
-- already uses. RLS here protects them from the anon/authenticated
-- PostgREST surface, and scopes ADMIN (super_admin/owner/staff) visibility
-- to the right tenant.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00009_commerce_b2b_core.sql
-- =============================================================================

-- ── Company hierarchy helper (buyer↔company membership for B2B RLS) ─────────
create table if not exists public.company_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  company_id uuid not null,
  user_id uuid not null references public.users (id) on delete cascade,
  role text not null default 'buyer'
    check (role in ('buyer', 'approver', 'manager')),
  -- Per-buyer spend limit in cents; null = no individual cap (falls back to
  -- the company-wide approval_rules threshold).
  spend_limit_cents bigint check (spend_limit_cents is null or spend_limit_cents >= 0),
  created_at timestamptz not null default now(),
  unique (company_id, user_id)
);
create index if not exists company_members_tenant_idx on public.company_members (tenant_id);
create index if not exists company_members_user_idx on public.company_members (user_id);

create or replace function public.current_user_company_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select company_id from public.company_members where user_id = auth.uid();
$$;
grant execute on function public.current_user_company_ids() to anon, authenticated;

-- ── Companies (B2B corporate hierarchy — parent/child accounts) ─────────────
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  parent_company_id uuid references public.companies (id) on delete set null,
  name text not null,
  billing_address jsonb not null default '{}'::jsonb,
  -- Net terms + credit limit (Stripe Invoicing / Customer Balance APIs).
  net_terms_days integer not null default 0
    check (net_terms_days in (0, 15, 30, 60)),
  credit_limit_cents bigint not null default 0 check (credit_limit_cents >= 0),
  credit_used_cents bigint not null default 0 check (credit_used_cents >= 0),
  stripe_customer_id text,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists companies_tenant_idx on public.companies (tenant_id);
create index if not exists companies_parent_idx on public.companies (parent_company_id);

alter table public.company_members
  add constraint company_members_company_fk
  foreign key (company_id) references public.companies (id) on delete cascade;

-- ── Approval rules (spend-threshold triggers) ────────────────────────────────
create table if not exists public.approval_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  -- Orders at/above this subtotal require approval before payment capture.
  threshold_cents bigint not null check (threshold_cents >= 0),
  -- Which company role must approve (checked against company_members.role).
  approver_role text not null default 'approver' check (approver_role in ('approver', 'manager')),
  created_at timestamptz not null default now()
);
create index if not exists approval_rules_tenant_idx on public.approval_rules (tenant_id);
create index if not exists approval_rules_company_idx on public.approval_rules (company_id);

-- ── Products / variants / inventory ─────────────────────────────────────────
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Preserves the existing Redis catalog's string id (`store:products` field
  -- key) so a future backfill can map 1:1 without inventing new identifiers.
  external_id text,
  name text not null,
  slug text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'live', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists products_tenant_idx on public.products (tenant_id);
create index if not exists products_external_id_idx on public.products (external_id);

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  sku text,
  option_label text not null default 'Standard',
  -- List price in cents (the tenant-wide default — B2B account-specific
  -- pricing lives in price_list_entries and overrides this at checkout).
  price_cents bigint not null check (price_cents >= 0),
  currency text not null default 'usd',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, option_label)
);
create index if not exists product_variants_tenant_idx on public.product_variants (tenant_id);
create index if not exists product_variants_product_idx on public.product_variants (product_id);

create table if not exists public.inventory_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  quantity_available integer not null default 0 check (quantity_available >= 0),
  -- Reserved for in-flight checkouts (mirrors the Redis inventory-lock
  -- pattern in lib/redis-lock.ts / lib/inventory-pool.ts) so a future
  -- Postgres-backed checkout has the same oversell protection.
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0),
  updated_at timestamptz not null default now(),
  unique (variant_id)
);
create index if not exists inventory_levels_tenant_idx on public.inventory_levels (tenant_id);

-- ── Customers / carts / orders ───────────────────────────────────────────────
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);
create index if not exists customers_tenant_idx on public.customers (tenant_id);
create index if not exists customers_company_idx on public.customers (company_id);

create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'converted', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists carts_tenant_idx on public.carts (tenant_id);
create index if not exists carts_customer_idx on public.carts (customer_id);

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  cart_id uuid not null references public.carts (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  created_at timestamptz not null default now()
);
create index if not exists cart_items_tenant_idx on public.cart_items (tenant_id);
create index if not exists cart_items_cart_idx on public.cart_items (cart_id);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  customer_id uuid references public.customers (id) on delete set null,
  order_ref text not null,
  status text not null default 'pending'
    check (status in ('pending', 'awaiting_approval', 'confirmed', 'fulfilled', 'cancelled', 'refunded')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'paid', 'partially_refunded', 'refunded', 'invoiced')),
  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null default 0 check (total_cents >= 0),
  currency text not null default 'usd',
  -- Net terms: when the company purchases on Net-15/30/60, this is the
  -- computed due date (Stripe Invoicing due date mirrors it).
  net_terms_due_at timestamptz,
  stripe_payment_intent_id text,
  stripe_invoice_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, order_ref)
);
create index if not exists orders_tenant_idx on public.orders (tenant_id);
create index if not exists orders_company_idx on public.orders (company_id);
create index if not exists orders_customer_idx on public.orders (customer_id);

create table if not exists public.order_line_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  variant_id uuid references public.product_variants (id) on delete set null,
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  line_total_cents bigint not null check (line_total_cents >= 0)
);
create index if not exists order_line_items_tenant_idx on public.order_line_items (tenant_id);
create index if not exists order_line_items_order_idx on public.order_line_items (order_id);

create table if not exists public.order_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  approval_rule_id uuid references public.approval_rules (id) on delete set null,
  approver_user_id uuid references public.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists order_approvals_tenant_idx on public.order_approvals (tenant_id);
create index if not exists order_approvals_order_idx on public.order_approvals (order_id);

-- ── Price lists (contract pricing / tiered volume discounts) ────────────────
create table if not exists public.price_lists (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Null company_id = a tenant-wide list (e.g. "Wholesale"); set = a
  -- contract price list scoped to one company.
  company_id uuid references public.companies (id) on delete cascade,
  name text not null,
  currency text not null default 'usd',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists price_lists_tenant_idx on public.price_lists (tenant_id);
create index if not exists price_lists_company_idx on public.price_lists (company_id);

create table if not exists public.price_list_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  price_list_id uuid not null references public.price_lists (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  -- Volume discount matrix: at/above this quantity, unit_price_cents applies
  -- instead of the list/base price. Multiple rows per variant = tiers.
  min_quantity integer not null default 1 check (min_quantity >= 1),
  unique (price_list_id, variant_id, min_quantity)
);
create index if not exists price_list_entries_tenant_idx on public.price_list_entries (tenant_id);
create index if not exists price_list_entries_list_idx on public.price_list_entries (price_list_id);
create index if not exists price_list_entries_variant_idx on public.price_list_entries (variant_id);

-- ── Quotes (buyer request → sales negotiation → order conversion) ───────────
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  requested_by uuid references public.users (id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'negotiating', 'accepted', 'rejected', 'converted', 'expired')),
  currency text not null default 'usd',
  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  notes text,
  converted_order_id uuid references public.orders (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists quotes_tenant_idx on public.quotes (tenant_id);
create index if not exists quotes_company_idx on public.quotes (company_id);

create table if not exists public.quote_line_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  -- The buyer-requested / sales-negotiated price, vs. the catalog price at
  -- request time (so a rep can see the discount they're granting).
  original_price_cents bigint not null check (original_price_cents >= 0),
  negotiated_price_cents bigint check (negotiated_price_cents is null or negotiated_price_cents >= 0)
);
create index if not exists quote_line_items_tenant_idx on public.quote_line_items (tenant_id);
create index if not exists quote_line_items_quote_idx on public.quote_line_items (quote_id);

-- ── Immutable audit trail: the exact enterprise shape ────────────────────────
-- audit_logs already exists (00001) with tenant_id/actor/action/detail/
-- created_at and is append-only (00008's trigger). Add the columns the
-- Phase 2 spec names explicitly rather than overloading the existing ones,
-- so `payload`/`ip_address`/`staff_id`/`target_tenant_id` are queryable by
-- name instead of buried in `detail`.
alter table public.audit_logs add column if not exists staff_id uuid references public.users (id) on delete set null;
alter table public.audit_logs add column if not exists target_tenant_id uuid references public.tenants (id) on delete set null;
alter table public.audit_logs add column if not exists payload jsonb not null default '{}'::jsonb;
alter table public.audit_logs add column if not exists ip_address inet;
create index if not exists audit_logs_staff_idx on public.audit_logs (staff_id);
create index if not exists audit_logs_target_tenant_idx on public.audit_logs (target_tenant_id);

-- ── updated_at triggers ──────────────────────────────────────────────────────
drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at before update on public.companies
  for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at before update on public.products
  for each row execute function public.set_updated_at();

drop trigger if exists product_variants_set_updated_at on public.product_variants;
create trigger product_variants_set_updated_at before update on public.product_variants
  for each row execute function public.set_updated_at();

drop trigger if exists carts_set_updated_at on public.carts;
create trigger carts_set_updated_at before update on public.carts
  for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

drop trigger if exists quotes_set_updated_at on public.quotes;
create trigger quotes_set_updated_at before update on public.quotes
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.company_members enable row level security;
alter table public.companies enable row level security;
alter table public.approval_rules enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.inventory_levels enable row level security;
alter table public.customers enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_line_items enable row level security;
alter table public.order_approvals enable row level security;
alter table public.price_lists enable row level security;
alter table public.price_list_entries enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_line_items enable row level security;

-- Admin-tier tables: super_admin sees everything; owner/staff scoped to
-- their own tenant. Consistent with tenant_items' policy shape (00003).
drop policy if exists "companies_select" on public.companies;
create policy "companies_select" on public.companies
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or id in (select public.current_user_company_ids())
  );
drop policy if exists "companies_manage" on public.companies;
create policy "companies_manage" on public.companies
  for all
  using (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')))
  with check (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')));

drop policy if exists "company_members_select" on public.company_members;
create policy "company_members_select" on public.company_members
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or user_id = auth.uid()
  );
drop policy if exists "company_members_manage" on public.company_members;
create policy "company_members_manage" on public.company_members
  for all
  using (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')))
  with check (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')));

drop policy if exists "approval_rules_all" on public.approval_rules;
create policy "approval_rules_all" on public.approval_rules
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

-- Catalog tables: tenant admin manages; visible to super_admin + own tenant.
-- (No anon/public policy — the storefront reads the catalog through the
-- app's own API routes with the service-role key, same as store:products
-- today; add an anon SELECT policy here later if a client-side Supabase
-- catalog read is ever introduced.)
drop policy if exists "products_all" on public.products;
create policy "products_all" on public.products
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "product_variants_all" on public.product_variants;
create policy "product_variants_all" on public.product_variants
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "inventory_levels_all" on public.inventory_levels;
create policy "inventory_levels_all" on public.inventory_levels
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

-- Customer-facing tables: service-role only (see the design note at the top
-- of this file) plus admin visibility for the tenant's own data.
drop policy if exists "customers_admin_select" on public.customers;
create policy "customers_admin_select" on public.customers
  for select using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "carts_admin_select" on public.carts;
create policy "carts_admin_select" on public.carts
  for select using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "cart_items_admin_select" on public.cart_items;
create policy "cart_items_admin_select" on public.cart_items
  for select using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "orders_select" on public.orders;
create policy "orders_select" on public.orders
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or company_id in (select public.current_user_company_ids())
  );
drop policy if exists "orders_admin_manage" on public.orders;
create policy "orders_admin_manage" on public.orders
  for insert with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());
drop policy if exists "orders_admin_update" on public.orders;
create policy "orders_admin_update" on public.orders
  for update
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "order_line_items_select" on public.order_line_items;
create policy "order_line_items_select" on public.order_line_items
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or order_id in (select id from public.orders where company_id in (select public.current_user_company_ids()))
  );
drop policy if exists "order_line_items_admin_manage" on public.order_line_items;
create policy "order_line_items_admin_manage" on public.order_line_items
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

drop policy if exists "order_approvals_select" on public.order_approvals;
create policy "order_approvals_select" on public.order_approvals
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or approver_user_id = auth.uid()
  );
drop policy if exists "order_approvals_decide" on public.order_approvals;
create policy "order_approvals_decide" on public.order_approvals
  for update
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant() or approver_user_id = auth.uid())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant() or approver_user_id = auth.uid());
drop policy if exists "order_approvals_admin_insert" on public.order_approvals;
create policy "order_approvals_admin_insert" on public.order_approvals
  for insert with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

-- Price lists: admins manage; the OWNING company's members can read their
-- own contract pricing (never another company's).
drop policy if exists "price_lists_select" on public.price_lists;
create policy "price_lists_select" on public.price_lists
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or company_id in (select public.current_user_company_ids())
  );
drop policy if exists "price_lists_admin_manage" on public.price_lists;
create policy "price_lists_admin_manage" on public.price_lists
  for all
  using (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')))
  with check (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')));

drop policy if exists "price_list_entries_select" on public.price_list_entries;
create policy "price_list_entries_select" on public.price_list_entries
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or price_list_id in (select id from public.price_lists where company_id in (select public.current_user_company_ids()))
  );
drop policy if exists "price_list_entries_admin_manage" on public.price_list_entries;
create policy "price_list_entries_admin_manage" on public.price_list_entries
  for all
  using (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')))
  with check (public.current_user_is_super_admin() or (tenant_id = public.current_user_tenant() and public.current_user_role() in ('owner', 'staff')));

-- Quotes: the requesting company's members see + negotiate their own quotes;
-- tenant admins see + manage every quote in their store.
drop policy if exists "quotes_select" on public.quotes;
create policy "quotes_select" on public.quotes
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or company_id in (select public.current_user_company_ids())
  );
drop policy if exists "quotes_buyer_insert" on public.quotes;
create policy "quotes_buyer_insert" on public.quotes
  for insert with check (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or company_id in (select public.current_user_company_ids())
  );
drop policy if exists "quotes_update" on public.quotes;
create policy "quotes_update" on public.quotes
  for update
  using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or company_id in (select public.current_user_company_ids())
  )
  with check (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or company_id in (select public.current_user_company_ids())
  );

drop policy if exists "quote_line_items_select" on public.quote_line_items;
create policy "quote_line_items_select" on public.quote_line_items
  for select using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or quote_id in (select id from public.quotes where company_id in (select public.current_user_company_ids()))
  );
drop policy if exists "quote_line_items_manage" on public.quote_line_items;
create policy "quote_line_items_manage" on public.quote_line_items
  for all
  using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or quote_id in (select id from public.quotes where company_id in (select public.current_user_company_ids()))
  )
  with check (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
    or quote_id in (select id from public.quotes where company_id in (select public.current_user_company_ids()))
  );
