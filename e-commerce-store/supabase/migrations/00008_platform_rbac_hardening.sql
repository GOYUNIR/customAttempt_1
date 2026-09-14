-- =============================================================================
-- 00008_platform_rbac_hardening.sql — makes the 4-tier RBAC schema (00003)
-- actually enforceable: immutable audit trail, sales↔tenant assignments, and
-- the RLS policies `tenants`/`users` never got (RLS was enabled on both in
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
--       on (lib/rbac.ts's `canAccessTenant()` has always had this concept —
--       `Actor.assignedTenantIds` — but nothing in the schema modeled it).
--   tenants / users RLS    — super_admin full access; owner/staff scoped to
--       their own tenant; sales scoped to their assigned tenants.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
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
