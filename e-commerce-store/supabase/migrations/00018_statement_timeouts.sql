-- 00018_statement_timeouts.sql
--
-- Phase B item 6 (server side). The client half — request timeouts, bounded
-- retries, abort — lives in lib/db-timeout-policy.ts and is applied at
-- services/config/supabase-client.ts's supabaseRestFetch.
--
-- A client-side abort stops THIS app waiting for a slow query. It does NOT
-- stop the query: Postgres keeps executing it, holding locks and a worker,
-- long after nobody is listening. Under load that is how one pathological
-- query saturates the pool and takes the storefront down with it. Only a
-- server-side statement_timeout actually kills the work.
--
-- Timeouts are set PER ROLE, matching the client tiers:
--
--   anon           storefront reads, unauthenticated. Shortest: a public
--                  catalog query that needs >5s is broken, not slow, and the
--                  visitor has already left.
--   authenticated  signed-in customer + admin sessions. Slightly longer:
--                  dashboards legitimately aggregate more.
--   service_role   cron jobs, backfills, migrations. Longest, because these
--                  are batch operations nobody is waiting on — but still
--                  bounded, so a runaway job cannot hold locks forever.
--
-- These are DEFAULTS. A specific long-running statement can still opt out for
-- its own transaction with `SET LOCAL statement_timeout`.

alter role anon set statement_timeout = '5s';
alter role authenticated set statement_timeout = '10s';
alter role service_role set statement_timeout = '60s';

-- idle_in_transaction_session_timeout: a session that opens a transaction and
-- then stops talking (a crashed Worker mid-write, a dropped connection) holds
-- its locks indefinitely. This releases them. It is deliberately much shorter
-- for the interactive roles than for batch work.
alter role anon set idle_in_transaction_session_timeout = '15s';
alter role authenticated set idle_in_transaction_session_timeout = '30s';
alter role service_role set idle_in_transaction_session_timeout = '120s';

-- Verify after applying (psql):
--   select rolname, rolconfig from pg_roles
--    where rolname in ('anon','authenticated','service_role');
