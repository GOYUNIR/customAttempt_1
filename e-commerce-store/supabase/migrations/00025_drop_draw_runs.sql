-- 00025 — draw RUNS, closing DEFERRED-7.
--
-- WHY drop_draws WAS NOT ENOUGH. 00012's `drop_draws` is one row per VARIANT:
-- variant_id, winner_count, entries_count, executed_at. A draw RUN is not that
-- shape. `draws:history` stores one entry per run, containing a
-- `processedWinners[]` array where each winner carries its own product, size,
-- status, amountCents and orderRef. One run spans many variants, and
-- `draws:last` — the "most recent run" the admin status screen reads — had no
-- home in the schema at all.
--
-- WHY IT WAITED FOR THE ORDERS WORK. Those `orderRef` and `amountCents` fields
-- are ORDER facts living inside a draw record. Designing a run table before
-- orders were relational would have meant designing against a shape that was
-- about to change. Now `orders.order_ref` is unique per tenant and carries
-- checkout_mode, so a winner row can point at the order that charged them
-- instead of restating its money.
--
-- THE SPLIT:
--   drop_draw_runs  — one row per execution of the draw engine (when, in which
--                     timezone, what it charged in total)
--   drop_draws      — unchanged, one row per variant drawn, now carrying
--                     run_id so a run's per-variant detail is a join rather
--                     than a jsonb scan
--
-- `winners` stays jsonb rather than becoming a fourth table. Every question
-- asked of it today ("show me this run") reads the whole run at once, and the
-- per-winner facts worth querying across runs — who was charged, how much —
-- are in `orders`, which is where they belong. A winners table that duplicated
-- orders would be a second place for the same money to disagree.

create table if not exists public.drop_draw_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  executed_at timestamptz not null default now(),
  -- The engine formats execution time for display in the store's own timezone
  -- (GOYUNIR_STORE_SUITE.dropSchedule.timezone). Kept so a run reads the same
  -- later as it did on the day, rather than being silently re-rendered in
  -- whatever timezone the reader happens to be in.
  timezone text,

  -- How the run was started. An automated cron draw and an operator pressing
  -- the button are different events, and telling them apart after the fact is
  -- most of what an incident review needs.
  trigger_source text not null default 'auto'
    check (trigger_source in ('auto', 'manual', 'dry_run')),

  total_charges integer not null default 0 check (total_charges >= 0),
  total_revenue_cents bigint not null default 0 check (total_revenue_cents >= 0),

  -- The per-winner outcome list, as the engine produced it: email, product,
  -- size, status, amountCents, orderRef. See the header for why this is not
  -- its own table.
  winners jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now()
);

-- "The most recent run" (what draws:last served) and "the last 50 runs" (what
-- draws:history served) are the only two reads, and both are this index.
create index if not exists drop_draw_runs_tenant_executed_idx
  on public.drop_draw_runs (tenant_id, executed_at desc);

-- Link the existing per-variant rows to their run. Nullable: rows written
-- before this migration have no run to point at, and inventing one would
-- fabricate an execution that never happened.
alter table public.drop_draws
  add column if not exists run_id uuid references public.drop_draw_runs (id) on delete cascade;

create index if not exists drop_draws_run_idx on public.drop_draws (run_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Same admin-tier shape as drop_draws itself (00012). A run record names the
-- customers who won and what they were charged, so it is not public data.
alter table public.drop_draw_runs enable row level security;

drop policy if exists "drop_draw_runs_all" on public.drop_draw_runs;
create policy "drop_draw_runs_all" on public.drop_draw_runs
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

comment on table public.drop_draw_runs is
  'One row per execution of the draw engine. drop_draws stays one row per VARIANT drawn and now carries run_id. Closes DEFERRED-7; see this migration''s header for why it waited for the orders work.';
comment on column public.drop_draw_runs.winners is
  'Per-winner outcomes as the engine produced them. Deliberately not a table: the money facts (charged, amount) live in orders, and duplicating them would create a second place for the same money to disagree.';
comment on column public.drop_draw_runs.trigger_source is
  'auto = the cron engine, manual = an operator pressed the button, dry_run = a rehearsal that charged nobody.';
