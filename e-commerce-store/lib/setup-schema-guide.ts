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
  kind: 'ai_secondary' | 'stripe_price_id' | 'full';
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

const FULL_FILES: SchemaFixMigration[] = [
  { file: 'supabase/migrations/00001_init.sql', sql: MIGRATION_00001 },
  { file: 'supabase/migrations/00002_setup_operational.sql', sql: MIGRATION_00002 },
  { file: 'supabase/migrations/00003_tenant_routing.sql', sql: MIGRATION_00003 },
  { file: 'supabase/migrations/00004_ai_secondary.sql', sql: MIGRATION_00004 },
  { file: 'supabase/migrations/00005_stripe_price_id.sql', sql: MIGRATION_00005 },
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
  return {
    kind: 'full',
    title: 'Your Supabase database is missing its schema.',
    summary: 'The platform tables were never created.',
    intro:
      'The Supabase project could not be reached because its tables were never created. Apply the five migrations below in order to build the schema, then click Continue.',
    steps: [
      ...OPEN_STEPS,
      'For EACH file below — in order, 00001 → 00002 → 00003 → 00004 → 00005 — click its “Copy SQL” button, paste it into the query box, and click “Run”. Wait for “Success” before moving to the next file.',
      'Come back to this page and click “Continue” again.',
    ],
    migrations: FULL_FILES,
    verify: 'What success looks like: a green “Success” result for each file with no red error text.',
    cli: 'Shortcut: if you have the Supabase CLI installed, run `supabase db push` in the project folder — it applies all five migrations in order automatically.',
  };
}

/** A plain-text rendering of a plan (used for the API error string / logs). */
export function schemaFixPlanToText(plan: SchemaFixPlan): string {
  return [plan.title, '', plan.intro, '', ...plan.steps, '', plan.verify, '', plan.cli].join('\n');
}
