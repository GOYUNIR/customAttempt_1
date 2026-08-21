-- =============================================================================
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
-- Apply with: `supabase db push` or `psql "$DATABASE_URL" -f 00001_init.sql`
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
  map_provider text check (map_provider in ('mapbox', 'google_maps', 'open_street_map')),
  map_api_key text,
  ai_provider text check (ai_provider in ('deepseek', 'deepseek_lite', 'openai', 'anthropic', 'replicate', 'workers_ai', 'openrouter', 'groq', 'mistral', 'google_gemini')),
  ai_api_key text,
  ai_provider_secondary text check (ai_provider_secondary in ('deepseek', 'deepseek_lite', 'openai', 'anthropic', 'replicate', 'workers_ai', 'openrouter', 'groq', 'mistral', 'google_gemini')),
  ai_api_key_secondary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The app reads/writes the singleton row under this fixed id.
insert into public.global_platform_settings (id, is_configured)
values ('00000000-0000-0000-0000-0000000000c0', false)
on conflict (id) do nothing;

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

-- Super-admins (service role bypasses RLS anyway) can do everything on the
-- settings row; anon gets no direct read so secrets never leak over PostgREST.
create policy "super_admin_manage_settings" on public.global_platform_settings
  for all using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_super_admin = true
  ));

create policy "super_admin_manage_profiles" on public.profiles
  for all using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_super_admin = true
  ));

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
