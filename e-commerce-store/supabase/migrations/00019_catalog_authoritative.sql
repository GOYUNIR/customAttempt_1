-- 00019_catalog_authoritative.sql
--
-- PHASE G — make Postgres the authoritative catalog store.
--
-- Until now Postgres mirrored a Redis catalog that carried ~50 fields per
-- product while `products` held 7 columns. That was an honest tradeoff while
-- Redis was authoritative; it becomes data loss the moment the flag flips.
--
-- The existing Redis catalog is TEST DATA and is explicitly disposable, so
-- this migration does NOT attempt to carry it across. It gives the schema a
-- home for the full field set so NEW writes are complete.
--
-- SPLIT RULE — real column vs `config` jsonb:
--   Real column when the field is QUERIED, FILTERED, CONSTRAINED, or is a
--   genuine control worth the database enforcing (purchase limits are real
--   money/abuse controls; lifecycle flags decide what a storefront shows).
--   `config` jsonb for presentation and copy, which changes shape often and
--   is only ever read back whole. Same precedent as 00014's
--   tenant_store_config, which solved this exact problem for store config.
--
-- Inventing 40 relational columns for display copy would be weeks of schema
-- churn for no query benefit.

-- ── Lifecycle: decides what the storefront renders ──────────────────────────
alter table public.products add column if not exists is_active boolean not null default false;
alter table public.products add column if not exists is_archived boolean not null default false;
alter table public.products add column if not exists is_upcoming boolean not null default false;

-- Product-level default checkout mode. Per-variant overrides already live on
-- product_variants.checkout_mode (00012) and win where set.
alter table public.products add column if not exists checkout_mode text
  check (checkout_mode is null or checkout_mode in ('RAFFLE', 'FCFS'));
alter table public.products add column if not exists product_type text;

-- ── Purchase limits: real controls, not presentation ────────────────────────
-- These cap how much one buyer can take. Burying them in jsonb would put a
-- money/abuse control somewhere the database cannot constrain it.
alter table public.products add column if not exists max_per_email integer not null default 1
  check (max_per_email >= 1);
alter table public.products add column if not exists max_per_cart integer not null default 1
  check (max_per_cart >= 1);
alter table public.products add column if not exists max_raffle_allocation_limit integer not null default 0
  check (max_raffle_allocation_limit >= 0);

-- ── Ordering + stock totals: sorted and compared in queries ─────────────────
alter table public.products add column if not exists sort_order integer not null default 0;
alter table public.products add column if not exists total_inventory integer not null default 0
  check (total_inventory >= 0);

-- ── Drop schedule ──────────────────────────────────────────────────────────
-- TEXT, deliberately, NOT timestamptz. lib/drop-timestamps.ts treats these as
-- NAIVE WALL-CLOCK strings interpreted in the STORE's timezone: "2026-10-01
-- 18:00" means 6pm where the store is, and the draw engine, countdown and
-- catalog all agree on that reading. timestamptz would force a UTC
-- interpretation at write time and silently shift every existing drop.
alter table public.products add column if not exists go_live_at text;
alter table public.products add column if not exists release_ends_at text;

-- ── Categories: filtered on in the catalog UI ──────────────────────────────
alter table public.products add column if not exists categories jsonb not null default '[]'::jsonb;

-- ── Everything else: presentation, copy, and per-size config blocks ─────────
-- notes, crops, winnerTiers, inventoryPerSize, sizeConfigs, customDropSchedule,
-- commerceMode/accessRule/billingRule/scheduleConfig, prefix, soldOut*,
-- urgency*, show*, status*, sampler*, mixedFormat*, delivery* — read back whole
-- by lib/postgres-catalog-read.ts, never queried field-by-field.
alter table public.products add column if not exists config jsonb not null default '{}'::jsonb;

-- ── Per-variant extras ─────────────────────────────────────────────────────
-- A priceCategories entry carries its own limits and rule blocks. checkout_mode
-- (00012), shared_pool_id (00012) and custom_schedule (00016) already have
-- columns; this holds the remainder (per-size maxPerEmail/maxPerCart/
-- maxRaffleAllocationLimit, commerceMode, accessRule, billingRule,
-- scheduleConfig, winnerTiers, stripeId).
alter table public.product_variants add column if not exists config jsonb not null default '{}'::jsonb;

-- Sorting the catalog is the single hottest read.
create index if not exists products_tenant_sort_idx on public.products (tenant_id, sort_order);
-- The storefront asks for live, non-archived products constantly.
create index if not exists products_tenant_lifecycle_idx on public.products (tenant_id, is_active, is_archived);

-- Verify after applying:
--   select column_name, data_type from information_schema.columns
--    where table_name = 'products' order by ordinal_position;
