-- =============================================================================
-- 00005_stripe_price_id.sql — default Stripe price ID on the settings row.
--
-- Adds `stripe_price_id` to `public.global_platform_settings`. This is the
-- global fallback Stripe Price ID the operator can set from the admin portal
-- ("API Keys & Integrations") / Setup Wizard instead of only via the
-- `STRIPE_PRODUCT_ID` environment variable. Resolution order at checkout:
--   1. per-product/size price ID (stored in Redis) — always wins
--   2. this admin-saved default price ID
--   3. the legacy STRIPE_PRODUCT_ID env var
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get this column straight from 00001_init.sql, so this is a no-op there).
-- Apply with: `supabase db push` or `psql "$DATABASE_URL" -f 00005_stripe_price_id.sql`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists stripe_price_id text;
