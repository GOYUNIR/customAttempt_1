-- =============================================================================
-- 00006_ai_3d_mesh.sql — modular 3D mesh / image-to-3D engine provider columns.
--
-- Adds the optional 3D asset / image-to-3D engine configuration to the settings
-- row so the storefront can route Image-to-3D tasks to Tripo3D / Meshy /
-- Stability 3D / a custom webhook, alongside the LLM prompt compiler:
--
--   ai_model        — model selector for the PRIMARY LLM (not a secret).
--   ai3d_provider   — the 3D engine provider (check-constrained enum).
--   ai3d_key        — the 3D engine API key (secret, never echoed).
--   ai3d_endpoint   — the 3D engine base URL / endpoint (not a secret).
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get these columns straight from 00001_init.sql, so this is a no-op there).
-- Apply with: `supabase db push` or `psql "$DATABASE_URL" -f 00006_ai_3d_mesh.sql`
-- =============================================================================

alter table public.global_platform_settings
  add column if not exists ai_model text;

alter table public.global_platform_settings
  add column if not exists ai3d_provider text
  check (ai3d_provider in ('tripo3d', 'meshy', 'stability_3d', 'custom_webhook'));

alter table public.global_platform_settings
  add column if not exists ai3d_key text;

alter table public.global_platform_settings
  add column if not exists ai3d_endpoint text;
