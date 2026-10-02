-- 00046_rls_policy_tables.sql — row level security on the two signup policy
-- tables, explicitly.
--
-- Found by scripts/bootstrap/schema-parity.ts (2026-10-02): every other public
-- table enables RLS in its own migration, but these two (00041) relied on the
-- live project's "enable RLS automatically" dashboard setting (the
-- rls_auto_enable event trigger), which a FRESH project does not have. Their
-- grants were already revoked from anon/authenticated (00041), so nothing was
-- exposed; this makes a fresh install match live and every other table.
-- service_role bypasses RLS, so the server's reads are unchanged. Idempotent.

alter table public.platform_policies enable row level security;
alter table public.disposable_email_domains enable row level security;
