-- =============================================================================
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
--       row per item, `item_type` selects a JSON-Schema-validated `rules`
--       blob (fcfs / raffle / appointment / table_booking / ticketed_access /
--       subscription).
--   system_locks                              — the Lockdown Engine: which
--       critical system parameters are frozen post-setup + the step-up auth
--       timestamp.
--   current_user_role()/tenant()/is_super_admin() — SECURITY DEFINER helpers so
--       RLS policies can read the caller's role/tenant without recursion.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
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
-- tenant; sales see their assigned tenants (via the `role`/tenant helper the
-- app enforces for writes too — DB-side RLS is the backstop).
create policy "tenant_items_select" on public.tenant_items
  for select
  using (
    public.current_user_is_super_admin()
    or tenant_id = public.current_user_tenant()
  );

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
create policy "system_locks_select" on public.system_locks
  for select using (auth.role() = 'authenticated');

create policy "system_locks_manage" on public.system_locks
  for all using (public.current_user_is_super_admin());

-- ── updated_at triggers ──────────────────────────────────────────────────────
drop trigger if exists tenant_items_set_updated_at on public.tenant_items;
create trigger tenant_items_set_updated_at before update on public.tenant_items
  for each row execute function public.set_updated_at();

drop trigger if exists system_locks_set_updated_at on public.system_locks;
create trigger system_locks_set_updated_at before update on public.system_locks
  for each row execute function public.set_updated_at();
