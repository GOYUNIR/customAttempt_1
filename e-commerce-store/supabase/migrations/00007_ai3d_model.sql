-- =============================================================================
-- 00007_ai3d_model.sql — model selector for the 3D asset / image-to-3D engine.
--
-- Adds `ai3d_model` to `public.global_platform_settings`. This is the optional
-- model string the 3D mesh engine should use (e.g. `tripo3d-v2.0`, `tripo3d-v2.5`,
-- `meshy-4`) — the mirror of `ai_model` for the LLM prompt compiler. NOT a secret
-- (echoed back for editing).
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get this column straight from 00001_init.sql, so this is a no-op there).
-- Apply with: `supabase db push` or `psql "$DATABASE_URL" -f 00007_ai3d_model.sql`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists ai3d_model text;
