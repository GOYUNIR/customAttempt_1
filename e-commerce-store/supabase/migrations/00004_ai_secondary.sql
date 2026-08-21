-- =============================================================================
-- 00004_ai_secondary.sql — mandatory AI engine + secondary fallback provider.
--
-- 1. Widens the `ai_provider` check constraint to include the new providers
--    (DeepSeek Lite, OpenRouter, Groq, Mistral, Google Gemini).
-- 2. Adds the optional SECONDARY AI columns (tried when the primary fails).
--
-- The AI engine is now MANDATORY (primary key required) with an optional
-- secondary fallback — see services/config/types.ts + services/ai/.
--
-- Idempotent: safe to run on top of an already-migrated schema (fresh installs
-- get these columns + the widened constraint straight from 00001_init.sql, so
-- this migration is a no-op there).
-- Apply with: `supabase db push` or `psql "$DATABASE_URL" -f 00004_ai_secondary.sql`
-- =============================================================================

-- Widen the primary AI provider check (the inline check is auto-named
-- `global_platform_settings_ai_provider_check`).
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
