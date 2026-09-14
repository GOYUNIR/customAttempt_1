-- =============================================================================
-- 00011_variant_order_metadata.sql — opaque metadata columns for the fields
-- this store's live Redis catalog has that the 00009 generic commerce schema
-- does not yet model relationally: raffle vs FCFS checkout mode, winner
-- tiers, drop scheduling, shared-inventory sync slugs.
--
-- This is NOT the same thing as actually modeling raffles/drops in Postgres
-- (that needs real columns/tables — checkout_mode, entry pools, draw
-- scheduling — with their own RLS and business rules, a deliberately
-- separate, larger piece of work). This migration only makes
-- scripts/migrate-redis-to-supabase.ts NON-LOSSY: the raffle-specific fields
-- round-trip as opaque JSON instead of being silently dropped during
-- backfill, so nothing is lost while that larger schema design happens.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00011_variant_order_metadata.sql
-- =============================================================================

alter table public.product_variants
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.orders
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.products
  add column if not exists metadata jsonb not null default '{}'::jsonb;
