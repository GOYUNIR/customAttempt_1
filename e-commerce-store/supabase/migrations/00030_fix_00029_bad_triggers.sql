-- ─────────────────────────────────────────────────────────────────────────────
-- 00030 — UNDO the five triggers 00029 installed on tables that have no
-- `updated_at` column at all.
--
-- WHAT I GOT WRONG. 00029 set out to fix nine tables whose `updated_at` column
-- existed but was never maintained. Four of them were that. The other five
-- NEVER HAD THE COLUMN:
--
--     customers, cart_items, price_list_entries, approval_rules, company_members
--
-- `public.set_updated_at()` assigns `NEW.updated_at`, and in PL/pgSQL assigning
-- a field that does not exist on the row type is a runtime error, not a no-op.
-- So the trigger did not quietly do nothing — it made EVERY UPDATE on those
-- five tables fail outright:
--
--     PATCH /customers ... 400
--     {"code":"42703","message":"record \"new\" has no field \"updated_at\""}
--
-- That is a write-path outage, caught in production Worker logs as a customer's
-- rewards balance failing to save after a real charge. `customers` and
-- `cart_items` are on the live storefront path; the other three are B2B
-- pricing, approvals and membership. INSERTs were unaffected (the trigger is
-- BEFORE UPDATE), which is why new buyers still worked and the damage was
-- limited to updating anything that already existed.
--
-- HOW IT HAPPENED, since that is the part worth not repeating: the nine-table
-- list was assembled by reading migration files for `updated_at ... default
-- now()` and reasoning about which lacked a trigger. It was never checked
-- against the live schema. Four of the nine were right, which made the batch
-- look right. The correct check is one query per table against the database
-- that will actually run the trigger — the same "exercise it, don't assert it"
-- rule that every other change here is held to, skipped because DDL felt like
-- it did not need testing.
--
-- WHY DROP RATHER THAN ADD THE COLUMN. 00029's purpose was to stop a column
-- that existed from lying about itself. A table with no `updated_at` was never
-- lying; it simply does not track that, and restoring it to that state is the
-- change that matches the intent and the smallest one that ends the outage.
-- Adding `updated_at` to these five is a real schema decision — it needs the
-- backfill question answered again per table — and it should be made
-- deliberately, not smuggled in as the fix for a broken deployment.
--
-- The four triggers 00029 got right are LEFT IN PLACE:
--   inventory_levels, tenant_themes, tenant_store_config, store_kv
-- ─────────────────────────────────────────────────────────────────────────────

drop trigger if exists customers_set_updated_at on public.customers;
drop trigger if exists cart_items_set_updated_at on public.cart_items;
drop trigger if exists price_list_entries_set_updated_at on public.price_list_entries;
drop trigger if exists approval_rules_set_updated_at on public.approval_rules;
drop trigger if exists company_members_set_updated_at on public.company_members;

-- 00029 left this note on a column whose table it also broke. The note itself
-- is still true and still worth keeping; it just should not be the last word.
comment on column public.inventory_levels.updated_at is
  'Maintained by trigger (00029). Before that it recorded row creation only, which was read as proof a checkout had not decremented stock and cost four days chasing an oversell bug that did not exist. 00029 also installed this trigger on five tables that had no updated_at column, breaking every UPDATE on them until 00030 dropped those.';
