-- =============================================================================
-- 00017_theme_customizer.sql — the modular design-system data model: one
-- tenant can have multiple named themes, at most one ACTIVE at a time.
--
-- `sections` is a jsonb array of `{id, type, order, config}` (see
-- lib/theme-schema.ts for the validated shape — this table stores whatever
-- passes `validateThemeSections()`, not open-ended arbitrary jsonb). Sized
-- down from a full drag-and-drop page-builder (Shopify/VTEX-scale): a fixed
-- palette of section types, no plugin system, no per-block CSS injection —
-- a real, working MVP, not the full enterprise system.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00017_theme_customizer.sql
-- =============================================================================

create table if not exists public.tenant_themes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null default 'Default Theme',
  sections jsonb not null default '[]'::jsonb,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one active theme per tenant.
create unique index if not exists tenant_themes_one_active_idx
  on public.tenant_themes (tenant_id)
  where is_active;

create index if not exists tenant_themes_tenant_idx on public.tenant_themes (tenant_id);

-- Same admin-tier RLS shape as every other tenant-scoped table this session
-- (00012/00014/00016): tenant admins manage, no anon/authenticated PostgREST
-- surface — the app's own service-role-backed routes are the only writers.
alter table public.tenant_themes enable row level security;

drop policy if exists "tenant_themes_all" on public.tenant_themes;
create policy "tenant_themes_all" on public.tenant_themes
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());
