-- =============================================================================
-- 00015_sales_subroles.sql — real sales sub-roles (sales_rep, sales_admin,
-- deal_desk) alongside the existing 5-value RBAC role set from 00003
-- (super_admin, sales, owner, staff, customer).
--
-- Additive: no existing row's `role` value is touched. The legacy 'sales'
-- role keeps working (lib/admin-actor.ts's actorHasSalesAccess() still
-- accepts it) so an existing session isn't silently locked out mid-migration.
--
-- 00003's `role` check constraints were added inline (`add column ... check
-- (...)`) with Postgres-assigned auto-generated names, not `add constraint
-- users_role_check` — so this can't just DROP CONSTRAINT a hardcoded name.
-- Instead it finds and drops whatever check constraint on the `role` column
-- currently exists, then adds the widened one back under a stable name so a
-- future migration CAN target it directly.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00015_sales_subroles.sql
-- =============================================================================

do $$
declare
  con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.users'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.users drop constraint %I', con.conname);
  end loop;

  alter table public.users
    add constraint users_role_check
    check (role in ('super_admin', 'sales', 'sales_rep', 'sales_admin', 'deal_desk', 'owner', 'staff', 'customer'));
end $$;

do $$
declare
  con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', con.conname);
  end loop;

  alter table public.profiles
    add constraint profiles_role_check
    check (role is null or role in ('super_admin', 'sales', 'sales_rep', 'sales_admin', 'deal_desk', 'owner', 'staff', 'customer'));
end $$;
