-- =============================================================================
-- 00001_initial_schema.sql
-- Multi-tenant template platform — source-of-truth schema (Supabase / Postgres).
-- Tables: profiles, sites, site_settings, products.
-- Row-Level Security is ON everywhere; anonymous users can only SELECT data of
-- PUBLISHED sites, while the site owner has full CRUD on their own rows.
--
-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- Safe to re-run: all objects are created with IF NOT EXISTS / DROP ... IF
-- EXISTS guards.
-- =============================================================================

create extension if not exists pgcrypto;

-- ── profiles ─────────────────────────────────────────────────────────────────
-- One row per authenticated user, tied 1:1 to auth.users (auto-created by the
-- on_auth_user_created trigger below).
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

-- ── sites ────────────────────────────────────────────────────────────────────
create table if not exists public.sites (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  subdomain     text not null unique,
  custom_domain text unique,
  is_published  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint sites_subdomain_format check (subdomain ~* '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  constraint sites_custom_domain_format check (
    custom_domain is null or length(custom_domain) between 4 and 253
  )
);

create index if not exists sites_owner_idx     on public.sites (owner_id);
create index if not exists sites_published_idx on public.sites (is_published);

-- ── site_settings ────────────────────────────────────────────────────────────
-- Exactly one row per site. theme_config / layout_blocks are the fully dynamic
-- drag-and-drop section list the storefront renders from (see shared/types.ts).
create table if not exists public.site_settings (
  site_id       uuid primary key references public.sites (id) on delete cascade,
  site_name     text not null default 'My Store',
  theme_config  jsonb not null default '{}'::jsonb,
  layout_blocks jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);

-- ── products ─────────────────────────────────────────────────────────────────
-- `tags` is an extension beyond the minimum spec — it powers the storefront
-- category filter chips (a store without categories can't filter).
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.sites (id) on delete cascade,
  name        text not null,
  description text not null default '',
  price       numeric(12,2) not null default 0 check (price >= 0),
  image_url   text,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists products_site_active_idx
  on public.products (site_id, is_active, sort_order);

-- ── updated_at triggers ──────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists sites_set_updated_at on public.sites;
create trigger sites_set_updated_at
  before update on public.sites
  for each row execute function public.set_updated_at();

drop trigger if exists site_settings_set_updated_at on public.site_settings;
create trigger site_settings_set_updated_at
  before update on public.site_settings
  for each row execute function public.set_updated_at();

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ── auto-profile on signup ───────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
alter table public.profiles      enable row level security;
alter table public.sites         enable row level security;
alter table public.site_settings enable row level security;
alter table public.products      enable row level security;

-- profiles: users can read/update only their own row.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- sites: owner full CRUD; anonymous users read only PUBLISHED sites.
create policy "sites_owner_all" on public.sites
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "sites_anon_read_published" on public.sites
  for select using (is_published = true);

-- site_settings: owner full CRUD; anonymous read only when the site is published.
create policy "site_settings_owner_all" on public.site_settings
  for all using (
    exists (
      select 1 from public.sites s
      where s.id = site_settings.site_id and s.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.sites s
      where s.id = site_settings.site_id and s.owner_id = auth.uid()
    )
  );
create policy "site_settings_anon_read_published" on public.site_settings
  for select using (
    exists (
      select 1 from public.sites s
      where s.id = site_settings.site_id and s.is_published = true
    )
  );

-- products: owner full CRUD; anonymous read only when the site is published.
create policy "products_owner_all" on public.products
  for all using (
    exists (
      select 1 from public.sites s
      where s.id = products.site_id and s.owner_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.sites s
      where s.id = products.site_id and s.owner_id = auth.uid()
    )
  );
create policy "products_anon_read_published" on public.products
  for select using (
    exists (
      select 1 from public.sites s
      where s.id = products.site_id and s.is_published = true
    )
  );

-- ── grants ───────────────────────────────────────────────────────────────────
-- RLS is the real gate; grants simply open the door per role. The edge Worker
-- talks to PostgREST with the anon key, so `anon` gets SELECT on the tables it
-- renders from. The Admin Portal uses the service role key (bypasses RLS).
grant usage on schema public to anon, authenticated;

grant select on public.sites, public.site_settings, public.products to anon;

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.sites to authenticated;
grant select, insert, update, delete on public.site_settings to authenticated;
grant select, insert, update, delete on public.products to authenticated;

grant execute on function public.set_updated_at() to authenticated;

