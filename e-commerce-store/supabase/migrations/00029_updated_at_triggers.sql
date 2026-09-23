-- ─────────────────────────────────────────────────────────────────────────────
-- 00029 — updated_at triggers for the tables that were silently missing them.
--
-- WHY THIS EXISTS, AND IT IS WORTH READING. Nine tables declared
-- `updated_at timestamptz not null default now()` and then never maintained
-- it. `default now()` fires on INSERT only, so the column recorded when a row
-- was CREATED while claiming to record when it was last CHANGED. Every one of
-- these tables gets UPDATEd in normal operation, so the column was not merely
-- stale — it was confidently wrong.
--
-- THE COST WAS NOT HYPOTHETICAL. `inventory_levels.updated_at` read
-- 2026-09-16 on a row whose quantity had just been decremented by a live
-- checkout. That was taken as evidence the checkout had NOT touched inventory,
-- and from there as evidence of an oversell hole on the money path. It was
-- escalated as the single highest-priority bug on the project and carried for
-- four days. There was no oversell hole. The decrement had always worked; the
-- timestamp lied about it. A column that reports the wrong thing is worse than
-- one that reports nothing, because nobody distrusts a timestamp.
--
-- The function is `public.set_updated_at()` from 00001 — reused rather than
-- redefined, so there is exactly one definition of what "updated" means.
--
-- DELIBERATELY EXCLUDED, both append-only by design:
--   audit_logs       — 00008 installs a trigger that REJECTS updates outright.
--                      An update trigger there would be dead code guarding a
--                      path the database already refuses.
--   analytics_events — an event stream. A row that is written once and never
--                      revised has nothing for this to maintain.
--
-- NO BACKFILL. Existing rows keep whatever timestamp they have. The honest
-- value for "when did this last change" on historical rows is unknown, and
-- inventing one would recreate the exact failure this migration fixes —
-- a timestamp that looks authoritative and is not. Correctness starts now.
-- ─────────────────────────────────────────────────────────────────────────────

drop trigger if exists inventory_levels_set_updated_at on public.inventory_levels;
create trigger inventory_levels_set_updated_at
  before update on public.inventory_levels
  for each row execute function public.set_updated_at();

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

drop trigger if exists cart_items_set_updated_at on public.cart_items;
create trigger cart_items_set_updated_at
  before update on public.cart_items
  for each row execute function public.set_updated_at();

drop trigger if exists tenant_themes_set_updated_at on public.tenant_themes;
create trigger tenant_themes_set_updated_at
  before update on public.tenant_themes
  for each row execute function public.set_updated_at();

drop trigger if exists tenant_store_config_set_updated_at on public.tenant_store_config;
create trigger tenant_store_config_set_updated_at
  before update on public.tenant_store_config
  for each row execute function public.set_updated_at();

drop trigger if exists price_list_entries_set_updated_at on public.price_list_entries;
create trigger price_list_entries_set_updated_at
  before update on public.price_list_entries
  for each row execute function public.set_updated_at();

drop trigger if exists approval_rules_set_updated_at on public.approval_rules;
create trigger approval_rules_set_updated_at
  before update on public.approval_rules
  for each row execute function public.set_updated_at();

drop trigger if exists company_members_set_updated_at on public.company_members;
create trigger company_members_set_updated_at
  before update on public.company_members
  for each row execute function public.set_updated_at();

drop trigger if exists store_kv_set_updated_at on public.store_kv;
create trigger store_kv_set_updated_at
  before update on public.store_kv
  for each row execute function public.set_updated_at();

comment on column public.inventory_levels.updated_at is
  'Maintained by trigger (00029). Before that it recorded row creation only, which was read as proof a checkout had not decremented stock and cost four days chasing an oversell bug that did not exist.';
