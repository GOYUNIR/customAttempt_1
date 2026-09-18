-- ─────────────────────────────────────────────────────────────────────────────
-- 00028 — PLATFORM LEADS: people who want to talk to us about buying this.
--
-- WHY THIS EXISTS. The Scale plan's "Contact us" button pointed at #start —
-- the merchant self-signup form. Every enterprise prospect who wanted a
-- conversation was handed a create-your-own-store wizard instead, and nothing
-- recorded that they had asked. There was no table to put them in.
--
-- NOT A TENANT TABLE. `public.leads` would imply a merchant's own leads. These
-- are OUR leads — people evaluating the platform — so they hang off no tenant
-- and are visible only to platform staff. A merchant must never see them, which
-- is why `tenant_id` is absent rather than nullable: a nullable tenant column
-- on an RLS-scoped table is one forgotten predicate away from a leak.
--
-- THE TIMESTAMPS ARE THE PRODUCT. `first_response_at` minus `created_at` is
-- the speed-to-lead metric, and it is stored rather than derived from an email
-- log because the whole claim of module 14 is that we can state the number. A
-- response time reconstructed later from whatever happens to be in the mail
-- provider is not a measurement.
--
-- STATUS IS DELIBERATELY SHORT. new -> working -> won/lost. A richer pipeline
-- is a CRM, and we are not building one until somebody is paying for a seat;
-- until then the honest answer is that a lead is either answered or it is not.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.platform_leads (
  id uuid primary key default gen_random_uuid(),

  email text not null,
  name text,
  company text,
  -- Free text from the form. Whatever they actually asked for, kept verbatim:
  -- the first reply is better when it answers the question that was asked.
  message text,

  -- Where they came from, e.g. 'pricing_scale', 'platform_hero'. Plain text and
  -- not an enum, so adding a capture point is a form change and not a migration.
  source text not null default 'unknown',

  status text not null default 'new'
    check (status in ('new', 'working', 'won', 'lost')),

  -- Who on our side owns it. Free text (an email) rather than a FK to
  -- public.users: a lead may be claimed by somebody before their staff account
  -- exists, and refusing the claim for that reason helps nobody.
  claimed_by text,
  claimed_at timestamptz,

  -- THE METRIC. Set exactly once, by the first human reply.
  first_response_at timestamptz,

  -- Set when the speed-to-lead module has told us this one is going cold, so it
  -- nags once rather than every time the job runs.
  nudged_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The queue the sales team works: unanswered, oldest first. Partial, because
-- answered leads are the overwhelming majority over time and do not belong in
-- an index whose only job is finding the ones that are still waiting.
create index if not exists platform_leads_unanswered_idx
  on public.platform_leads (created_at)
  where first_response_at is null and status = 'new';

create index if not exists platform_leads_email_idx on public.platform_leads (lower(email));
create index if not exists platform_leads_created_idx on public.platform_leads (created_at desc);

-- Keep updated_at honest. 00001 already defines set_updated_at(); reuse it
-- rather than growing a second copy that can drift from the first.
drop trigger if exists platform_leads_set_updated_at on public.platform_leads;
create trigger platform_leads_set_updated_at
  before update on public.platform_leads
  for each row execute function public.set_updated_at();

alter table public.platform_leads enable row level security;

-- PLATFORM STAFF ONLY. There is no tenant predicate to get wrong because there
-- is no tenant column: a merchant's token cannot satisfy this policy under any
-- circumstances. Public submissions arrive through the service role, which
-- bypasses RLS — the API route is what rate-limits and validates them.
drop policy if exists "platform_leads_staff" on public.platform_leads;
create policy "platform_leads_staff" on public.platform_leads
  for all using (public.current_user_is_super_admin())
  with check (public.current_user_is_super_admin());

comment on table public.platform_leads is
  'People asking to talk to us about buying the platform. Ours, not a merchant''s — no tenant_id, platform staff only.';
comment on column public.platform_leads.first_response_at is
  'Set once, by the first human reply. created_at -> here IS the speed-to-lead metric; it is stored rather than reconstructed from a mail log because a number we cannot state is not a measurement.';
comment on column public.platform_leads.nudged_at is
  'When the speed-to-lead module last warned us this lead was going cold. Present so it nags once rather than on every run.';
