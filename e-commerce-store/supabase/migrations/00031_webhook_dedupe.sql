-- ─────────────────────────────────────────────────────────────────────────────
-- 00031 — webhook dedupe as a real table, replacing a KV blob.
--
-- WHAT IT REPLACES. "Has this Stripe checkout session already been
-- processed?" lived in store_kv under `entries:processed`: ONE jsonb blob
-- holding every processed session id as a sorted set, plus a per-session
-- `cache:dedupe-claim:*` counter row. Claiming a session meant an isMember
-- read, an incr, an expire and a zadd — each a read-then-write of a whole
-- blob with no compare-and-swap. Roughly eight PostgREST round trips on the
-- checkout webhook, which measured 51 subrequests against the Workers free
-- plan's ceiling of 50.
--
-- WHY IT IS ALSO A CORRECTNESS CHANGE, not only a cheaper one. The claim was
-- documented as atomic and is not: every step is read-modify-write. Six
-- concurrent double-deliveries of one event never double-processed it, but
-- the same runs left a claim row reading {"v":2,"e":null} — the second
-- delivery's stale write erased the expiry the first had set. That is a lost
-- update in exactly this path, observed in production. The counter surviving
-- was timing, not construction.
--
-- A primary key makes the claim a single INSERT ... ON CONFLICT DO NOTHING:
-- the database decides who won, in one statement, by construction.
--
-- THE STATUS COLUMN fixes a second problem. The old claim was taken before
-- any work and never released, so a handler that crashed mid-run left its
-- session claimed forever; Stripe's retry then returned `already_processed`
-- and the sale was never completed. Rows here are 'claimed' until the handler
-- finishes and marks them 'done'. A 'claimed' row older than a few minutes
-- (lib/webhook-dedupe.ts, STALE_CLAIM_MS) is an abandoned run, and a retry
-- may take it over — atomically, via UPDATE ... WHERE claimed_at < cutoff,
-- which only one concurrent retry can match.
--
-- NO TENANT COLUMN, deliberately. Stripe object ids are globally unique, and
-- after Connect a session still has exactly one id across all accounts.
-- `scope` names what kind of key it is so the table can dedupe other
-- providers' events later without a schema change.
--
-- NOT PRUNED. One row per checkout session is tiny, and "was this session
-- processed, and when?" is worth keeping as an audit trail. The KV version
-- dropped entries after three days.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.webhook_dedupe (
  scope text not null,
  dedupe_key text not null,
  status text not null default 'claimed' check (status in ('claimed', 'done')),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (scope, dedupe_key)
);

-- The reclaim path filters on status + claimed_at.
create index if not exists webhook_dedupe_stale_idx
  on public.webhook_dedupe (status, claimed_at);

-- Server-only, like every other table here: the service role bypasses RLS,
-- and nothing else may read or write it.
alter table public.webhook_dedupe enable row level security;

-- ── Backfill from the KV blob ─────────────────────────────────────────────
-- Every session the KV store already knows was processed becomes a 'done'
-- row, so a Stripe redelivery of an event handled BEFORE this migration is
-- still recognised afterwards. Without this, the cutover would forget recent
-- sessions and a redelivery would process them twice.
--
-- Current format (read from production, not inferred): key
-- 'entries:processed', value {"v":[{"m":<session>,"s":<epoch ms>}],"t":"zset"}.
-- The older SET format ({"v":[<session>,...],"t":"set"}) is handled too;
-- lib/redis-maintenance.ts still converts it lazily, so it may exist.
insert into public.webhook_dedupe (scope, dedupe_key, status, claimed_at, completed_at)
select 'stripe_checkout_session',
       elem ->> 'm',
       'done',
       to_timestamp((elem ->> 's')::double precision / 1000),
       to_timestamp((elem ->> 's')::double precision / 1000)
from public.store_kv kv,
     jsonb_array_elements((kv.value::jsonb) -> 'v') as elem
where kv.key = 'entries:processed'
  and (kv.value::jsonb) ->> 't' = 'zset'
  and jsonb_typeof(elem) = 'object'
  and coalesce(elem ->> 'm', '') <> ''
on conflict do nothing;

insert into public.webhook_dedupe (scope, dedupe_key, status, claimed_at, completed_at)
select 'stripe_checkout_session', elem #>> '{}', 'done', now(), now()
from public.store_kv kv,
     jsonb_array_elements((kv.value::jsonb) -> 'v') as elem
where kv.key = 'entries:processed'
  and (kv.value::jsonb) ->> 't' = 'set'
  and jsonb_typeof(elem) = 'string'
on conflict do nothing;
