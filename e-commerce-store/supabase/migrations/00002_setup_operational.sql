-- =============================================================================
-- 00002_setup_operational.sql — operational settings JSONB column.
--
-- The unified /admin/setup dashboard persists operational (env-var-style)
-- settings — admin password, cron secret, Stripe keys, AI keys, storage driver
-- credentials, site identity — into `global_platform_settings` as a single
-- JSONB blob so the wizard has one place to store everything the operator
-- entered, without adding two dozen columns. The blob is NEVER returned to the
-- browser (toPublicSummary() omits it); only the service-role driver layer
-- reads it.
--
-- Apply with: `supabase db push` or `psql "$DATABASE_URL" -f 00002_setup_operational.sql`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists operational_settings jsonb not null default '{}'::jsonb;
