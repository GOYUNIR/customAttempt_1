-- =============================================================================
-- 00003_global_platform_settings.sql
-- Driver-engine global settings (the Setup Wizard's source of truth).
--
-- This migration adds the SINGLE source of truth for the provider API keys a
-- self-hosted buyer configures in the first-run Setup Wizard (/admin/setup):
--
--   global_platform_settings.is_configured = false  →  middleware blocks the
--   standard admin login and forces /admin → /admin/setup.
--
-- Security model (per spec):
--   • The table is completely invisible to `anon` AND `authenticated`.
--   • Only AUTHENTICATED SUPER-ADMINS can SELECT or UPDATE it (row-level
--     security driven by `profiles.is_super_admin`).
--   • The ONLY public read is `is_platform_configured()` — a SECURITY DEFINER
--     function that returns a single boolean so the Edge middleware can check
--     the gate without ever touching the keys.
--
-- Requires: 00001_initial_schema.sql (profiles table + set_updated_at()).
-- Safe to re-run: every object is created with IF NOT EXISTS / guarded DDL.
-- =============================================================================

-- ── profiles.is_super_admin ─────────────────────────────────────────────────
-- The RLS gate for the global settings table. Default false; the Setup Wizard
-- (service role) flips it to true for the master account it creates.
alter table public.profiles
  add column if not exists is_super_admin boolean not null default false;

-- ── global_platform_settings ────────────────────────────────────────────────
create table if not exists public.global_platform_settings (
  id                    uuid primary key default gen_random_uuid(),
  is_configured         boolean not null default false,
  mail_provider         text,
  mail_api_key          text,
  payment_provider      text,
  payment_api_key       text,
  payment_webhook_secret text,
  stripe_price_id       text,
  map_provider          text,
  map_api_key           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Only the three enumerated providers per category are ever accepted, so a
  -- bad wizard payload can never poison the driver factory switch.
  constraint global_platform_settings_mail_provider_check check (
    mail_provider is null or mail_provider in ('resend', 'postmark', 'sendgrid')
  ),
  constraint global_platform_settings_payment_provider_check check (
    payment_provider is null or payment_provider in ('stripe', 'lemon_squeezy', 'paddle')
  ),
  constraint global_platform_settings_map_provider_check check (
    map_provider is null or map_provider in ('mapbox', 'google_maps', 'open_street_map')
  )
);

-- At most ONE global settings row, ever (the Setup Wizard upserts a fixed id).
-- `((true))` is a Postgres trick: the partial unique index is on a constant
-- expression, so the table can hold at most one row regardless of id.
create unique index if not exists global_platform_settings_singleton
  on public.global_platform_settings ((true));

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists global_platform_settings_updated_at on public.global_platform_settings;
create trigger global_platform_settings_updated_at
  before update on public.global_platform_settings
  for each row execute function public.set_updated_at();

-- ── super-admin helper ──────────────────────────────────────────────────────
-- SECURITY DEFINER on purpose: the policy function must run with the row
-- security of the function OWNER (who has the profiles grant) while the CALLER
-- (the RLS evaluation) only needs EXECUTE. `search_path` is pinned so a
-- malicious `profiles` in the caller's schema can never be hijacked.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_super_admin = true
  );
$$;

-- ── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
alter table public.global_platform_settings enable row level security;

-- Absolute block on public access: explicitly revoke everything from the two
-- built-in roles (PostgREST maps `anon`/`authenticated` to them). No INSERT or
-- DELETE policy exists at all, so even a super-admin cannot add rows through
-- RLS — the Setup Wizard writes with the service role, which bypasses RLS.
revoke all on table public.global_platform_settings from anon, authenticated;

create policy "global_platform_settings_super_admin_select"
  on public.global_platform_settings
  for select using (public.is_super_admin());

create policy "global_platform_settings_super_admin_update"
  on public.global_platform_settings
  for update using (public.is_super_admin()) with check (public.is_super_admin());

-- ── public configuration gate (the ONLY public read) ────────────────────────
-- The Edge middleware (middleware.ts) calls this RPC to decide whether to
-- force /admin → /admin/setup. It returns exactly one boolean — the table and
-- its keys stay locked away behind the super-admin policies above.
create or replace function public.is_platform_configured()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_configured from public.global_platform_settings limit 1), false);
$$;

grant execute on function public.is_platform_configured() to anon, authenticated;
