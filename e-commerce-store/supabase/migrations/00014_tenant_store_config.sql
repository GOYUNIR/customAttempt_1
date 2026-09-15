-- =============================================================================
-- 00014_tenant_store_config.sql — a relational (jsonb) home for the tenant
-- configuration `app/api/store/route.ts` currently reads from Redis
-- (STORE_CONFIG_KEY, and the schedule/social-proof fields under
-- OVERRIDES_KEY).
--
-- This is genuinely tenant CONFIGURATION (theme colors, drop schedule, hero
-- content, social-proof counters, catalog section order, behavior flags) —
-- not a commerce entity — so it's stored as jsonb here, the same shape it
-- already has in Redis, rather than invented as relational columns. See
-- lib/postgres-catalog-read.ts's header for how this is read.
--
-- No admin flow writes to this table yet (that's a separate, follow-up
-- piece of work — see DEPLOYMENT.md) — an absent row is the normal "not
-- populated yet" state, read as empty config by lib/postgres-catalog-read.ts,
-- exactly like an unconfigured Redis store today.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00014_tenant_store_config.sql
-- =============================================================================

create table if not exists public.tenant_store_config (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  schedule_override jsonb not null default '{}'::jsonb,
  social_override jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Same admin-tier shape as inventory_levels/orders/00012's drop-mode tables:
-- tenant admins (super_admin / owner / staff of the tenant) manage; nothing
-- here is exposed to the anon/authenticated PostgREST surface directly (the
-- app's own service-role-backed routes are the only writers/readers).
alter table public.tenant_store_config enable row level security;

drop policy if exists "tenant_store_config_all" on public.tenant_store_config;
create policy "tenant_store_config_all" on public.tenant_store_config
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());
