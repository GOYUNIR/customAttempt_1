-- =============================================================================
-- 00016_product_marketing_media.sql — real columns for the storefront-
-- authoring fields lib/postgres-catalog-read.ts's header (Phase 3) documents
-- as having "no relational home": tagline, marketing notes, the image
-- gallery, and per-variant custom drop schedules.
--
-- Dedicated, purpose-named columns (not folded into the existing generic
-- `metadata` jsonb from 00011) so they're self-documenting and directly
-- queryable/indexable, matching the rest of this schema's convention of a
-- real column for anything with a known, stable shape.
--
-- Idempotent — safe to re-run. Apply with `supabase db push` or:
--   psql "$DATABASE_URL" -f 00016_product_marketing_media.sql
-- =============================================================================

alter table public.products
  add column if not exists tagline text;

alter table public.products
  add column if not exists marketing_notes jsonb not null default '[]'::jsonb;

-- Array of { url: string, crop?: { x, y, w, h } }, mirroring the Redis
-- catalog's `images`/`crops` parallel-array shape as one combined array
-- instead of two — see lib/postgres-catalog-read.ts's hydration mapping.
alter table public.products
  add column if not exists media_gallery jsonb not null default '[]'::jsonb;

alter table public.product_variants
  add column if not exists custom_schedule jsonb not null default '{}'::jsonb;
