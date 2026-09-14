/**
 * setup-schema-guide.ts — the single source of truth for the Setup Wizard's
 * "Supabase schema not applied" fix.
 *
 * Imported by BOTH the server route (`app/api/admin/setup/route.ts`) and the
 * client page (`app/admin/setup/page.tsx`), so the two can never drift. It is
 * a pure module with zero server-only dependencies.
 *
 * ⚠️ KEEP IN SYNC: the SQL string constants below are a verbatim copy of
 * `supabase/migrations/*.sql`. If you edit a migration file, update the
 * matching constant here in the same change set (mirrors the AGENTS.md rule).
 */

/** Whether an error message looks like a Supabase schema-not-applied problem. */
export function isSchemaError(message: string): boolean {
  return /could not find the table|could not find the '|schema cache|PGRST204|PGRST205|does not exist|42703|42P01|42704/i.test(message);
}

export type SchemaFixMigration = {
  /** File name (shown to the operator + used in copy labels). */
  file: string;
  /** The raw SQL the operator must run. */
  sql: string;
};

export type SchemaFixPlan = {
  kind:
    | 'ai_secondary'
    | 'stripe_price_id'
    | 'ai_3d_mesh'
    | 'rbac_hardening'
    | 'commerce_b2b'
    | 'custom_domains'
    | 'variant_order_metadata'
    | 'drop_mode_schema'
    | 'full';
  title: string;
  summary: string;
  intro: string;
  /** Ordered, explicit, numbered steps (ready to render as a list). */
  steps: string[];
  /** The exact migration(s) to run, in order. */
  migrations: SchemaFixMigration[];
  /** What a successful run looks like. */
  verify: string;
  /** The `supabase db push` shortcut. */
  cli: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// 00004_ai_secondary.sql — the most commonly missing migration.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00004 = `-- =============================================================================
-- 00004_ai_secondary.sql — mandatory AI engine + secondary fallback provider.
--
-- 1. Widens the \`ai_provider\` check constraint to include the new providers
--    (DeepSeek Lite, OpenRouter, Groq, Mistral, Google Gemini).
-- 2. Adds the optional SECONDARY AI columns (tried when the primary fails).
--
-- The AI engine is now MANDATORY (primary key required) with an optional
-- secondary fallback — see services/config/types.ts + services/ai/.
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get these columns + the widened constraint straight from 00001_init.sql, so
-- this migration is a no-op there).
-- Apply with: \`supabase db push\` or \`psql "$DATABASE_URL" -f 00004_ai_secondary.sql\`
-- =============================================================================

-- Widen the primary AI provider check (the inline check is auto-named
-- \`global_platform_settings_ai_provider_check\`).
alter table public.global_platform_settings
  drop constraint if exists global_platform_settings_ai_provider_check;

alter table public.global_platform_settings
  add constraint global_platform_settings_ai_provider_check
  check (ai_provider in ('deepseek', 'deepseek_lite', 'openai', 'anthropic', 'replicate', 'workers_ai', 'openrouter', 'groq', 'mistral', 'google_gemini'));

-- Optional secondary (fallback) AI provider + key.
alter table public.global_platform_settings
  add column if not exists ai_provider_secondary text
  check (ai_provider_secondary in ('deepseek', 'deepseek_lite', 'openai', 'anthropic', 'replicate', 'workers_ai', 'openrouter', 'groq', 'mistral', 'google_gemini'));

alter table public.global_platform_settings
  add column if not exists ai_api_key_secondary text;
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00005_stripe_price_id.sql — the default Stripe price ID column.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00005 = `-- =============================================================================
-- 00005_stripe_price_id.sql — default Stripe price ID on the settings row.
--
-- Adds \`stripe_price_id\` to \`public.global_platform_settings\`. This is the
-- global fallback Stripe Price ID the operator can set from the admin portal
-- ("API Keys & Integrations") / Setup Wizard instead of only via the
-- \`STRIPE_PRODUCT_ID\` environment variable. Resolution order at checkout:
--   1. per-product/size price ID (stored in Redis) — always wins
--   2. this admin-saved default price ID
--   3. the legacy STRIPE_PRODUCT_ID env var
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get this column straight from 00001_init.sql, so this is a no-op there).
-- Apply with: \`supabase db push\` or \`psql "$DATABASE_URL" -f 00005_stripe_price_id.sql\`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists stripe_price_id text;
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00006_ai_3d_mesh.sql — modular 3D mesh / image-to-3D engine columns.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00006 = `-- =============================================================================
-- 00006_ai_3d_mesh.sql — modular 3D mesh / image-to-3D engine provider columns.
--
-- Adds the optional 3D asset / image-to-3D engine configuration to the settings
-- row so the storefront can route Image-to-3D tasks to Tripo3D / Meshy /
-- Stability 3D / a custom webhook, alongside the LLM prompt compiler:
--
--   ai_model        — model selector for the PRIMARY LLM (not a secret).
--   ai3d_provider   — the 3D engine provider (check-constrained enum).
--   ai3d_key        — the 3D engine API key (secret, never echoed).
--   ai3d_endpoint   — the 3D engine base URL / endpoint (not a secret).
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get these columns straight from 00001_init.sql, so this is a no-op there).
-- Apply with: \`supabase db push\` or \`psql "$DATABASE_URL" -f 00006_ai_3d_mesh.sql\`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists ai_model text;

alter table public.global_platform_settings
  add column if not exists ai3d_provider text
  check (ai3d_provider in ('tripo3d', 'meshy', 'stability_3d', 'custom_webhook'));

alter table public.global_platform_settings
  add column if not exists ai3d_key text;

alter table public.global_platform_settings
  add column if not exists ai3d_endpoint text;
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00007_ai3d_model.sql — model selector for the 3D asset / image-to-3D engine.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00007 = `-- =============================================================================
-- 00007_ai3d_model.sql — model selector for the 3D asset / image-to-3D engine.
--
-- Adds \`ai3d_model\` to \`public.global_platform_settings\`. This is the optional
-- model string the 3D mesh engine should use (e.g. \`tripo3d-v2.0\`, \`tripo3d-v2.5\`,
-- \`meshy-4\`) — the mirror of \`ai_model\` for the LLM prompt compiler. NOT a secret
-- (echoed back for editing).
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get this column straight from 00001_init.sql, so this is a no-op there).
-- Apply with: \`supabase db push\` or \`psql "$DATABASE_URL" -f 00007_ai3d_model.sql\`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists ai3d_model text;
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00008_platform_rbac_hardening.sql — makes the 4-tier RBAC schema (00003)
// actually enforceable: immutable audit trail, sales↔tenant assignments, and
// the RLS policies tenants/users never got.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00008 = `-- =============================================================================
-- 00008_platform_rbac_hardening.sql — makes the 4-tier RBAC schema (00003)
-- actually enforceable: immutable audit trail, sales↔tenant assignments, and
-- the RLS policies \`tenants\`/\`users\` never got (RLS was enabled on both in
-- 00001 but no policy was ever added — meaning both were silently deny-all
-- for anon/authenticated, and only reachable through the service-role key).
--
--   audit_logs            — a database trigger blocks UPDATE/DELETE
--       UNCONDITIONALLY, even for the service-role key the app itself uses.
--       RLS alone doesn't get you real immutability: the service role
--       bypasses RLS by design, so an app bug (or a compromised service-role
--       key) could otherwise edit/erase history. The trigger is the actual
--       guarantee; RLS below just keeps normal reads scoped correctly.
--   sales_tenant_assignments — which tenants a 'sales' role account may act
--       on (lib/rbac.ts's \`canAccessTenant()\` has always had this concept —
--       \`Actor.assignedTenantIds\` — but nothing in the schema modeled it).
--   tenants / users RLS    — super_admin full access; owner/staff scoped to
--       their own tenant; sales scoped to their assigned tenants.
--
-- Idempotent — safe to re-run. Apply with \`supabase db push\` or:
--   psql "$DATABASE_URL" -f 00008_platform_rbac_hardening.sql
-- =============================================================================

-- ── Sales ↔ tenant assignments ───────────────────────────────────────────────
create table if not exists public.sales_tenant_assignments (
  sales_user_id uuid not null references public.users (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.users (id) on delete set null,
  primary key (sales_user_id, tenant_id)
);
create index if not exists sales_tenant_assignments_tenant_idx
  on public.sales_tenant_assignments (tenant_id);

alter table public.sales_tenant_assignments enable row level security;

drop policy if exists "sales_tenant_assignments_select" on public.sales_tenant_assignments;
create policy "sales_tenant_assignments_select" on public.sales_tenant_assignments
  for select
  using (
    public.current_user_is_super_admin()
    or sales_user_id = auth.uid()
  );

drop policy if exists "sales_tenant_assignments_manage" on public.sales_tenant_assignments;
create policy "sales_tenant_assignments_manage" on public.sales_tenant_assignments
  for all
  using (public.current_user_is_super_admin())
  with check (public.current_user_is_super_admin());

-- ── Immutable audit trail ─────────────────────────────────────────────────────
create or replace function public.audit_logs_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only — % is not permitted', tg_op;
end;
$$;

drop trigger if exists audit_logs_no_update on public.audit_logs;
create trigger audit_logs_no_update
  before update on public.audit_logs
  for each row execute function public.audit_logs_block_mutation();

drop trigger if exists audit_logs_no_delete on public.audit_logs;
create trigger audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function public.audit_logs_block_mutation();

drop policy if exists "audit_logs_select" on public.audit_logs;
create policy "audit_logs_select" on public.audit_logs
  for select
  using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
  );

drop policy if exists "audit_logs_insert" on public.audit_logs;
create policy "audit_logs_insert" on public.audit_logs
  for insert
  with check (auth.role() = 'authenticated' or auth.role() = 'service_role');

-- ── Tenants RLS (was enabled in 00001 with zero policies — deny-all) ─────────
drop policy if exists "tenants_select" on public.tenants;
create policy "tenants_select" on public.tenants
  for select
  using (
    public.current_user_is_super_admin()
    or id = public.current_user_tenant()
    or exists (
      select 1 from public.sales_tenant_assignments sta
      where sta.tenant_id = tenants.id and sta.sales_user_id = auth.uid()
    )
  );

drop policy if exists "tenants_manage" on public.tenants;
create policy "tenants_manage" on public.tenants
  for all
  using (public.current_user_is_super_admin())
  with check (public.current_user_is_super_admin());

-- ── Users RLS (only "read own row" existed — add super_admin manage) ────────
drop policy if exists "users_super_admin_manage" on public.users;
create policy "users_super_admin_manage" on public.users
  for all
  using (public.current_user_is_super_admin())
  with check (public.current_user_is_super_admin());

drop policy if exists "users_update_own" on public.users;
create policy "users_update_own" on public.users
  for update
  using (auth.uid() = id)
  with check (auth.uid() = id and role = (select role from public.users where id = auth.uid()));
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00009_commerce_b2b_core.sql — core commerce + B2B engine schema.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00009 = `-- =============================================================================
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
-- RLS DESIGN — every table below is tenant-isolated via \`current_user_tenant()\`
-- / \`current_user_is_super_admin()\` (00003/00008), consistent with the rest
-- of this schema. Customer-facing tables (customers/carts/cart_items/orders/
-- order_line_items) are intentionally NOT opened to the \`authenticated\`
-- Postgres role: this app's customer auth (app/api/auth/*) is its own
-- session system, not Supabase Auth, so those tables are accessed by the
-- Next.js server via the service-role key (which bypasses RLS) on behalf of
-- an already-session-validated customer — the same pattern \`store_kv\`
-- already uses. RLS here protects them from the anon/authenticated
-- PostgREST surface, and scopes ADMIN (super_admin/owner/staff) visibility
-- to the right tenant.
--
-- Idempotent — safe to re-run. Apply with \`supabase db push\` or:
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
  -- Preserves the existing Redis catalog's string id (\`store:products\` field
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
-- so \`payload\`/\`ip_address\`/\`staff_id\`/\`target_tenant_id\` are queryable by
-- name instead of buried in \`detail\`.
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
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00010_custom_domains.sql — Cloudflare for SaaS custom-hostname state.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00010 = `-- =============================================================================
-- 00010_custom_domains.sql — Cloudflare for SaaS custom-hostname state.
--
-- tenants.custom_domain already exists (00003) as the hostname a merchant
-- wants to map. This adds the fields Cloudflare's Custom Hostnames API
-- (/zones/:zone_id/custom_hostnames) actually returns, so the admin domain
-- panel (lib/cloudflare-saas.ts) can show real DNS/SSL verification status
-- without re-polling Cloudflare on every page load.
--
-- Idempotent — safe to re-run. Apply with \`supabase db push\` or:
--   psql "$DATABASE_URL" -f 00010_custom_domains.sql
-- =============================================================================

alter table public.tenants
  add column if not exists cloudflare_hostname_id text;

alter table public.tenants
  add column if not exists domain_status text
  check (domain_status in ('unconfigured', 'pending', 'active', 'error'))
  default 'unconfigured';

alter table public.tenants
  add column if not exists ssl_status text
  check (ssl_status in ('unconfigured', 'pending_validation', 'pending_issuance', 'active', 'error'))
  default 'unconfigured';

alter table public.tenants
  add column if not exists domain_verification jsonb not null default '{}'::jsonb;

alter table public.tenants
  add column if not exists domain_checked_at timestamptz;

create index if not exists tenants_domain_status_idx on public.tenants (domain_status);
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00011_variant_order_metadata.sql — opaque metadata for raffle-specific fields.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00011 = `-- =============================================================================
-- 00011_variant_order_metadata.sql — opaque metadata columns for the fields
-- this store's live Redis catalog has that the 00009 generic commerce schema
-- does not yet model relationally: raffle vs FCFS checkout mode, winner
-- tiers, drop scheduling, shared-inventory sync slugs.
--
-- This is NOT the same thing as actually modeling raffles/drops in Postgres
-- (that needs real columns/tables — checkout_mode, entry pools, draw
-- scheduling — with their own RLS and business rules, a deliberately
-- separate, larger piece of work). This migration only makes
-- scripts/migrate-redis-to-supabase.ts NON-LOSSY: the raffle-specific fields
-- round-trip as opaque JSON instead of being silently dropped during
-- backfill, so nothing is lost while that larger schema design happens.
--
-- Idempotent — safe to re-run. Apply with \`supabase db push\` or:
--   psql "$DATABASE_URL" -f 00011_variant_order_metadata.sql
-- =============================================================================

alter table public.product_variants
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.orders
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.products
  add column if not exists metadata jsonb not null default '{}'::jsonb;
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00012_drop_mode_schema.sql — native raffle/FCFS/waitlist/shared-pool schema.
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00012 = `-- =============================================================================
-- 00012_drop_mode_schema.sql — native schema for this store's real selling
-- modes: Raffle, FCFS, Waitlist, and Shared Inventory Pools. Closes the gap
-- lib/postgres-shadow-write.ts's header identified: checkout_mode/entry
-- pools/draws had no relational home in 00009, only opaque \`metadata\` jsonb.
--
--   product_variants.checkout_mode  — FCFS / RAFFLE / WAITLIST, first-class.
--   shared_inventory_pools          — multiple variants (e.g. the same size
--       synced across two products) drawing from ONE stock count, mirroring
--       lib/checkout-mode.ts's \`inventorySyncSlug\` concept.
--   raffle_entries                  — a pending entry BEFORE a draw decides
--       it (never charged yet) — the raffle concept 00009's generic \`orders\`
--       table has no room for (an order is always a confirmed sale).
--   drop_draws                      — one row per executed draw run.
--   waitlist_entries                — FCFS overflow / notify-when-available.
--
-- Idempotent — safe to re-run. Apply with \`supabase db push\` or:
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
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00002_setup_operational.sql
// ─────────────────────────────────────────────────────────────────────────────
export const MIGRATION_00002 = `-- =============================================================================
-- 00002_setup_operational.sql — operational settings JSONB column.
--
-- The unified /admin/setup dashboard persists operational (env-var-style)
-- settings — admin password, cron secret, Stripe keys, AI keys, storage driver
-- credentials, site identity — into \`global_platform_settings\` as a single
-- JSONB blob so the wizard has one place to store everything the operator
-- entered, without adding two dozen columns. The blob is NEVER returned to the
-- browser (toPublicSummary() omits it); only the service-role driver layer
-- reads it.
--
-- Apply with: \`supabase db push\` or \`psql "$DATABASE_URL" -f 00002_setup_operational.sql\`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists operational_settings jsonb not null default '{}'::jsonb;
`;

// ─────────────────────────────────────────────────────────────────────────────
// 00001_init.sql — the core schema (tables + RLS + the settings row).
// Split into three pieces so the module stays easy to diff against the file.
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATION_00001_A = `-- =============================================================================
-- 00001_init.sql — Supabase schema (the storefront's PRIMARY data store).
--
-- This migration is the single source of truth for the tables the storefront +
-- the multi-tenant B2B SaaS features use when SUPABASE is the active storage
-- backend (see lib/storage/supabase.ts). It covers:
--
--   tenants                — the multi-tenant B2B SaaS tenants.
--   users                  — tenant-scoped end users (1:1 with auth.users).
--   profiles               — the super-admin profile flag the Setup Wizard +
--                            super-login flow reads/writes (back-compat with
--                            services/config).
--   global_platform_settings — the singleton "platform settings" row (email /
--                            payment / map / AI providers + is_configured gate).
--   store_kv               — the generic key-value table backing the Supabase
--                            StorageClient adapter (Redis-shaped commands).
--   analytics_events       — per-tenant usage events (API calls, AI generations,
--                            system events) for the admin analytics view.
--   audit_logs             — append-only admin audit trail.
--   outbound_webhooks      — webhook subscription + delivery state.
--
-- Apply with: \`supabase db push\` or \`psql "$DATABASE_URL" -f 00001_init.sql\`
-- (or run the SQL in the Supabase SQL editor).
-- =============================================================================

create extension if not exists "pgcrypto";

-- ── Tenants ─────────────────────────────────────────────────────────────────
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  license_status text not null default 'active'
    check (license_status in ('active', 'grace', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Users (tenant-scoped end users) ─────────────────────────────────────────
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid references public.tenants (id) on delete set null,
  email text not null,
  full_name text,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists users_tenant_idx on public.users (tenant_id);
create index if not exists users_email_idx on public.users (email);

-- ── Profiles (super-admin flag — back-compat with services/config) ──────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  is_super_admin boolean not null default false,
  tenant_id uuid references public.tenants (id) on delete set null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Platform settings (the singleton "platform_settings" row) ───────────────
create table if not exists public.global_platform_settings (
  id uuid primary key,
  is_configured boolean not null default false,
  mail_provider text check (mail_provider in ('resend', 'postmark', 'sendgrid')),
  mail_api_key text,
  payment_provider text check (payment_provider in ('stripe', 'lemon_squeezy', 'paddle')),
  payment_api_key text,
  payment_webhook_secret text,
  stripe_price_id text,
  map_provider text check (map_provider in ('mapbox', 'google_maps', 'open_street_map')),
  map_api_key text,
  ai_provider text check (ai_provider in ('deepseek', 'deepseek_lite', 'openai', 'anthropic', 'replicate', 'workers_ai', 'openrouter', 'groq', 'mistral', 'google_gemini')),
  ai_api_key text,
  ai_provider_secondary text check (ai_provider_secondary in ('deepseek', 'deepseek_lite', 'openai', 'anthropic', 'replicate', 'workers_ai', 'openrouter', 'groq', 'mistral', 'google_gemini')),
  ai_api_key_secondary text,
  ai_model text,
  ai3d_provider text check (ai3d_provider in ('tripo3d', 'meshy', 'stability_3d', 'custom_webhook')),
  ai3d_key text,
  ai3d_endpoint text,
  ai3d_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The app reads/writes the singleton row under this fixed id.
insert into public.global_platform_settings (id, is_configured)
values ('00000000-0000-0000-0000-0000000000c0', false)
on conflict (id) do nothing;
`;

const MIGRATION_00001_B = `
-- ── store_kv — generic KV backing the Supabase StorageClient adapter ────────
create table if not exists public.store_kv (
  key text primary key,
  value text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists store_kv_expires_idx on public.store_kv (expires_at);

-- ── Analytics events (per-tenant usage metrics) ─────────────────────────────
create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id) on delete cascade,
  event_type text not null
    check (event_type in ('api_call', 'ai_generation', 'system_event')),
  metric text not null,
  amount integer not null default 1,
  occurred_at timestamptz not null default now()
);
create index if not exists analytics_events_tenant_day_idx
  on public.analytics_events (tenant_id, occurred_at);

-- ── Audit logs (append-only) ────────────────────────────────────────────────
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id) on delete set null,
  actor text,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);

-- ── Outbound webhooks (subscriptions + delivery state) ──────────────────────
create table if not exists public.outbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id) on delete cascade,
  event text not null,
  url text not null,
  enabled boolean not null default true,
  last_delivery_at timestamptz,
  last_status integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists outbound_webhooks_tenant_idx on public.outbound_webhooks (tenant_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Owners (super-admins) can read/write their rows; anon can only read the
-- "is_platform_configured" RPC (never raw settings). Kept permissive here for
-- the storefront build; tighten per-deployment as needed.
alter table public.global_platform_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.users enable row level security;
alter table public.tenants enable row level security;
alter table public.analytics_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.outbound_webhooks enable row level security;
alter table public.store_kv enable row level security;
`;

const MIGRATION_00001_C = `
-- Super-admins (service role bypasses RLS anyway) can do everything on the
-- settings row; anon gets no direct read so secrets never leak over PostgREST.
drop policy if exists "super_admin_manage_settings" on public.global_platform_settings;
create policy "super_admin_manage_settings" on public.global_platform_settings
  for all using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_super_admin = true
  ));

drop policy if exists "super_admin_manage_profiles" on public.profiles;
create policy "super_admin_manage_profiles" on public.profiles
  for all using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_super_admin = true
  ));

drop policy if exists "users_read_own" on public.users;
create policy "users_read_own" on public.users
  for select using (auth.uid() = id);

-- ── is_platform_configured() RPC — the Setup Wizard gate ────────────────────
create or replace function public.is_platform_configured()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.global_platform_settings
    where is_configured = true
    limit 1
  );
$$;

grant execute on function public.is_platform_configured() to anon, authenticated;

-- ── updated_at trigger helper ───────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tenants_set_updated_at on public.tenants;
create trigger tenants_set_updated_at before update on public.tenants
  for each row execute function public.set_updated_at();

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at before update on public.users
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists global_platform_settings_set_updated_at on public.global_platform_settings;
create trigger global_platform_settings_set_updated_at before update on public.global_platform_settings
  for each row execute function public.set_updated_at();

drop trigger if exists outbound_webhooks_set_updated_at on public.outbound_webhooks;
create trigger outbound_webhooks_set_updated_at before update on public.outbound_webhooks
  for each row execute function public.set_updated_at();
`;

export const MIGRATION_00001 = MIGRATION_00001_A + MIGRATION_00001_B + MIGRATION_00001_C;

// ─────────────────────────────────────────────────────────────────────────────
// 00003_tenant_routing.sql
// ─────────────────────────────────────────────────────────────────────────────
const MIGRATION_00003_A = `-- =============================================================================
-- 00003_tenant_routing.sql — 4-tier RBAC + Universal Item Engine + Lockdown.
--
-- Extends the storefront's Supabase schema (00001_init.sql) with the pieces the
-- multi-tenant platform needs WITHOUT rewriting existing tables:
--
--   tenants.business_type / custom_domain — the business vertical + custom
--       domain each merchant maps from the /b portal (Tier 3).
--   users.role / profiles.role               — the RBAC role (super_admin /
--       sales / owner / staff / customer) that maps a user to a tier.
--   tenant_items                              — the Universal Item Engine: one
--       row per item, \`item_type\` selects a JSON-Schema-validated \`rules\`
--       blob (fcfs / raffle / appointment / table_booking / ticketed_access /
--       subscription).
--   system_locks                              — the Lockdown Engine: which
--       critical system parameters are frozen post-setup + the step-up auth
--       timestamp.
--   current_user_role()/tenant()/is_super_admin() — SECURITY DEFINER helpers so
--       RLS policies can read the caller's role/tenant without recursion.
--
-- Idempotent — safe to re-run. Apply with \`supabase db push\` or:
--   psql "$DATABASE_URL" -f 00003_tenant_routing.sql
-- =============================================================================

-- ── Tenants: business vertical + custom domain mapping ───────────────────────
alter table public.tenants
  add column if not exists business_type text;

alter table public.tenants
  add column if not exists custom_domain text;

-- A custom domain can map to at most one merchant (nulls are distinct).
create unique index if not exists tenants_custom_domain_key
  on public.tenants (custom_domain)
  where custom_domain is not null;

create index if not exists tenants_business_type_idx
  on public.tenants (business_type);

-- ── Users: RBAC role (mirrors lib/rbac.ts PortalRole) ────────────────────────
alter table public.users
  add column if not exists role text not null default 'customer'
  check (role in ('super_admin', 'sales', 'owner', 'staff', 'customer'));

create index if not exists users_role_idx on public.users (role);

-- Profiles carry the same flag for back-compat with services/config super-admin
alter table public.profiles
  add column if not exists role text
  check (role in ('super_admin', 'sales', 'owner', 'staff', 'customer'));

-- ── Universal Item Engine ────────────────────────────────────────────────────
create table if not exists public.tenant_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  item_type text not null
    check (item_type in ('fcfs', 'raffle', 'appointment', 'table_booking', 'ticketed_access', 'subscription')),
  name text not null,
  slug text not null,
  rules jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'live', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists tenant_items_tenant_idx on public.tenant_items (tenant_id);
create index if not exists tenant_items_type_idx on public.tenant_items (item_type);
create index if not exists tenant_items_rules_idx on public.tenant_items using gin (rules);

-- ── Lockdown Engine ──────────────────────────────────────────────────────────
create table if not exists public.system_locks (
  key text primary key,
  locked boolean not null default false,
  locked_by uuid,
  step_up_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

const MIGRATION_00003_B = `
-- ── SECURITY DEFINER role/tenant helpers (avoid RLS recursion in policies) ───
-- These read public.users with the definer's privileges so policies on other
-- tables can ask "who is the caller, and what tenant are they in?" safely.
create or replace function public.current_user_role()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce((select role from public.users where id = auth.uid()), 'customer')::text;
$$;
grant execute on function public.current_user_role() to anon, authenticated;

create or replace function public.current_user_tenant()
returns uuid
language sql stable security definer set search_path = public
as $$
  select (select tenant_id from public.users where id = auth.uid());
$$;
grant execute on function public.current_user_tenant() to anon, authenticated;

create or replace function public.current_user_is_super_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_super_admin from public.users where id = auth.uid()), false);
$$;
grant execute on function public.current_user_is_super_admin() to anon, authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.tenant_items enable row level security;
alter table public.system_locks enable row level security;

-- Tenant items: super admins see everything; owner/staff see + manage their own
-- tenant; sales see their assigned tenants (via the \`role\`/tenant helper the
-- app enforces for writes too — DB-side RLS is the backstop).
drop policy if exists "tenant_items_select" on public.tenant_items;
create policy "tenant_items_select" on public.tenant_items
  for select
  using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
  );

drop policy if exists "tenant_items_manage" on public.tenant_items;
create policy "tenant_items_manage" on public.tenant_items
  for all
  using (
    public.current_user_is_super_admin()
    or (
      tenant_id = public.current_user_tenant()
      and public.current_user_role() in ('owner', 'staff')
    )
  )
  with check (
    public.current_user_is_super_admin()
    or (
      tenant_id = public.current_user_tenant()
      and public.current_user_role() in ('owner', 'staff')
    )
  );

-- System locks: readable by any authenticated user (the lockdown engine checks
-- state); writable only by super admins.
drop policy if exists "system_locks_select" on public.system_locks;
create policy "system_locks_select" on public.system_locks
  for select using (auth.role() = 'authenticated');

drop policy if exists "system_locks_manage" on public.system_locks;
create policy "system_locks_manage" on public.system_locks
  for all using (public.current_user_is_super_admin());

-- ── updated_at triggers ──────────────────────────────────────────────────────
drop trigger if exists tenant_items_set_updated_at on public.tenant_items;
create trigger tenant_items_set_updated_at before update on public.tenant_items
  for each row execute function public.set_updated_at();

drop trigger if exists system_locks_set_updated_at on public.system_locks;
create trigger system_locks_set_updated_at before update on public.system_locks
  for each row execute function public.set_updated_at();
`;

export const MIGRATION_00003 = MIGRATION_00003_A + MIGRATION_00003_B;

// ─────────────────────────────────────────────────────────────────────────────
// buildSchemaFixPlan — turns a raw PostgREST error into a rich, stupid-proof
// step-by-step fix (with the exact SQL the operator must run, ready to copy).
// ─────────────────────────────────────────────────────────────────────────────
const AI_SECONDARY_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00004_ai_secondary.sql', sql: MIGRATION_00004 },
];

const STRIPE_PRICE_ID_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00005_stripe_price_id.sql', sql: MIGRATION_00005 },
];

const AI3D_MESH_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00006_ai_3d_mesh.sql', sql: MIGRATION_00006 },
  { file: 'supabase/migrations/00007_ai3d_model.sql', sql: MIGRATION_00007 },
];

const RBAC_HARDENING_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00008_platform_rbac_hardening.sql', sql: MIGRATION_00008 },
];

const COMMERCE_B2B_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00009_commerce_b2b_core.sql', sql: MIGRATION_00009 },
];

const CUSTOM_DOMAINS_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00010_custom_domains.sql', sql: MIGRATION_00010 },
];

const VARIANT_ORDER_METADATA_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00011_variant_order_metadata.sql', sql: MIGRATION_00011 },
];

const DROP_MODE_SCHEMA_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00012_drop_mode_schema.sql', sql: MIGRATION_00012 },
];

const FULL_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00001_init.sql', sql: MIGRATION_00001 },
  { file: 'supabase/migrations/00002_setup_operational.sql', sql: MIGRATION_00002 },
  { file: 'supabase/migrations/00003_tenant_routing.sql', sql: MIGRATION_00003 },
  { file: 'supabase/migrations/00004_ai_secondary.sql', sql: MIGRATION_00004 },
  { file: 'supabase/migrations/00005_stripe_price_id.sql', sql: MIGRATION_00005 },
  { file: 'supabase/migrations/00006_ai_3d_mesh.sql', sql: MIGRATION_00006 },
  { file: 'supabase/migrations/00007_ai3d_model.sql', sql: MIGRATION_00007 },
  { file: 'supabase/migrations/00008_platform_rbac_hardening.sql', sql: MIGRATION_00008 },
  { file: 'supabase/migrations/00009_commerce_b2b_core.sql', sql: MIGRATION_00009 },
  { file: 'supabase/migrations/00010_custom_domains.sql', sql: MIGRATION_00010 },
  { file: 'supabase/migrations/00011_variant_order_metadata.sql', sql: MIGRATION_00011 },
  { file: 'supabase/migrations/00012_drop_mode_schema.sql', sql: MIGRATION_00012 },
];

const OPEN_STEPS = [
  'Open https://supabase.com/dashboard in a new tab and sign in.',
  'Click the project you are connecting to (the one whose Project URL + service-role key you entered in Step 1 of this wizard).',
  'In the left sidebar, click “SQL Editor”.',
  'Click “+ New query” (the button at the top of the SQL Editor panel).',
];

export function buildSchemaFixPlan(errorText: string): SchemaFixPlan {
  const isStripePriceId = /stripe_price_id/i.test(errorText);
  if (isStripePriceId) {
    return {
      kind: 'stripe_price_id',
      title: 'Your Supabase database is missing the default Stripe price ID column.',
      summary: 'One migration (00005_stripe_price_id.sql) was never applied.',
      intro:
        'The Supabase project is reachable, but it is missing the stripe_price_id column on global_platform_settings. This takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: STRIPE_PRICE_ID_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “column … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  const isAiSecondary = /ai_provider_secondary|ai_api_key_secondary/i.test(errorText);
  if (isAiSecondary) {
    return {
      kind: 'ai_secondary',
      title: 'Your Supabase database is missing the optional AI-fallback columns.',
      summary: 'One migration (00004_ai_secondary.sql) was never applied.',
      intro:
        'The Supabase project is reachable, but it is missing two optional columns (ai_provider_secondary + ai_api_key_secondary). This is the most common setup error and takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: AI_SECONDARY_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “constraint … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  const isAi3dMesh = /ai3d_provider|ai3d_key|ai3d_endpoint|ai3d_model|ai_model/i.test(errorText);
  if (isAi3dMesh) {
    return {
      kind: 'ai_3d_mesh',
      title: 'Your Supabase database is missing the 3D mesh engine columns.',
      summary: 'Two migrations (00006_ai_3d_mesh.sql + 00007_ai3d_model.sql) were never applied.',
      intro:
        'The Supabase project is reachable, but it is missing the 3D asset / image-to-3D engine columns (ai_model, ai3d_provider, ai3d_key, ai3d_endpoint, ai3d_model). This takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: AI3D_MESH_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “column … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  const isRbacHardening = /sales_tenant_assignments|audit_logs_block_mutation|audit_logs_no_update|audit_logs_no_delete/i.test(errorText);
  if (isRbacHardening) {
    return {
      kind: 'rbac_hardening',
      title: 'Your Supabase database is missing the RBAC hardening tables.',
      summary: 'One migration (00008_platform_rbac_hardening.sql) was never applied.',
      intro:
        'The Supabase project is reachable, but it is missing the sales↔tenant assignment table and/or the audit-log immutability trigger. This takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: RBAC_HARDENING_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “policy … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  const isCommerceB2b = /public\.companies|public\.quotes|public\.price_lists|public\.company_members|public\.orders|public\.product_variants/i.test(errorText);
  if (isCommerceB2b) {
    return {
      kind: 'commerce_b2b',
      title: 'Your Supabase database is missing the commerce/B2B engine tables.',
      summary: 'One migration (00009_commerce_b2b_core.sql) was never applied.',
      intro:
        'The Supabase project is reachable, but it is missing the B2B engine tables (companies, price lists, quotes, approvals) and/or the core commerce tables (products, carts, orders). This takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: COMMERCE_B2B_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “relation … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  const isCustomDomains = /cloudflare_hostname_id|domain_status|ssl_status|domain_verification/i.test(errorText);
  if (isCustomDomains) {
    return {
      kind: 'custom_domains',
      title: 'Your Supabase database is missing the custom-domain columns.',
      summary: 'One migration (00010_custom_domains.sql) was never applied.',
      intro:
        'The Supabase project is reachable, but `tenants` is missing the Cloudflare custom-hostname status columns. This takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: CUSTOM_DOMAINS_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “column … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  const isVariantOrderMetadata =
    /metadata/i.test(errorText) && /product_variants|\borders\b|\bproducts\b/i.test(errorText);
  if (isVariantOrderMetadata) {
    return {
      kind: 'variant_order_metadata',
      title: 'Your Supabase database is missing the variant/order metadata columns.',
      summary: 'One migration (00011_variant_order_metadata.sql) was never applied.',
      intro:
        'The Supabase project is reachable, but `products`/`product_variants`/`orders` are missing their `metadata` jsonb column — used by the Redis backfill script to round-trip raffle-specific fields. This takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: VARIANT_ORDER_METADATA_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “column … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  const isDropModeSchema = /raffle_entries|drop_draws|waitlist_entries|shared_inventory_pools|checkout_mode/i.test(errorText);
  if (isDropModeSchema) {
    return {
      kind: 'drop_mode_schema',
      title: 'Your Supabase database is missing the raffle/FCFS/waitlist schema.',
      summary: 'One migration (00012_drop_mode_schema.sql) was never applied.',
      intro:
        'The Supabase project is reachable, but it is missing the native raffle/FCFS/waitlist/shared-pool tables (raffle_entries, drop_draws, waitlist_entries, shared_inventory_pools) and the checkout_mode column on product_variants. This takes about a minute to fix — nothing else is wrong and no data is touched.',
      steps: [
        ...OPEN_STEPS,
        'Click the green “Copy SQL” button on the file below — it copies the entire migration for you, so you do not need to find the file in the repo.',
        'Paste the SQL into the blank query box (Ctrl+V on Windows, Cmd+V on Mac).',
        'Click the green “Run” button (or press Ctrl+Enter / Cmd+Enter).',
        'Come back to this page and click “Continue” again — the data store will now verify.',
      ],
      migrations: DROP_MODE_SCHEMA_FILES,
      verify:
        'What success looks like: a green “Success. No rows returned” result with no red error. If you see “relation … already exists” instead, that is fine too — it means the fix is already applied, so just click Continue.',
      cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies this migration automatically.',
    };
  }
  return {
    kind: 'full',
    title: 'Your Supabase database is missing its schema.',
    summary: 'The platform tables were never created.',
    intro:
      'The Supabase project could not be reached because its tables were never created. Apply the twelve migrations below in order to build the schema, then click Continue.',
    steps: [
      ...OPEN_STEPS,
      'For EACH file below — in order, 00001 → 00002 → 00003 → 00004 → 00005 → 00006 → 00007 → 00008 → 00009 → 00010 → 00011 → 00012 — click its “Copy SQL” button, paste it into the query box, and click “Run”. Wait for “Success” before moving to the next file.',
      'Come back to this page and click “Continue” again.',
    ],
    migrations: FULL_FILES,
    verify: 'What success looks like: a green “Success” result for each file with no red error text.',
    cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies all twelve migrations in order automatically.',
  };
}

/** A plain-text rendering of a plan (used for the API error string / logs). */
export function schemaFixPlanToText(plan: SchemaFixPlan): string {
  return [plan.title, '', plan.intro, '', ...plan.steps, '', plan.verify, '', plan.cli].join('\n');
}
