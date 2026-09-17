-- 00023 — the drop-alert subscriber list.
--
-- WHY A NEW TABLE INSTEAD OF public.waitlist_entries
--
-- 00012 already has `waitlist_entries`, and at a glance `customer:waitlist`
-- looks like it belongs there. It does not, and putting it there would corrupt
-- that table's meaning for everyone who reads it later.
--
--   waitlist_entries  = "notify me when THIS VARIANT is available again".
--                       `variant_id uuid NOT NULL` references product_variants,
--                       unique (tenant_id, variant_id, email). FCFS overflow.
--
--   customer:waitlist = "email me about drops". One record per EMAIL, with the
--                       sources they signed up through and the interests they
--                       picked. There is no variant anywhere in the record,
--                       because the subscriber never chose one.
--
-- Forcing the second into the first would mean inventing a `variant_id` per
-- subscriber — a sentinel row, or one row per variant in the catalogue. Both
-- fabricate a fact the customer never stated. `waitlist_entries` stays empty
-- and reserved for its actual purpose (nothing writes it yet).
--
-- WHAT IS NOT MODELLED HERE, deliberately: `notified_slugs` is a jsonb map of
-- product slug -> ISO timestamp, copied as-is from the KV record, and it
-- answers "has this person already been emailed about this product?" — which
-- is the only question the send path (app/api/admin/alerts, action
-- `notifyProduct`) asks of it. It does NOT answer "who was notified about
-- product X", which would need its own table. That table is not invented here
-- because nothing asks that question yet.

create table if not exists public.alert_subscribers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null,

  -- Only the two states the code actually produces. The KV writer sets
  -- 'active'; the admin read path treats anything other than 'unsubscribed'
  -- as active. Speculative values ('bounced', 'pending') are left out — a
  -- CHECK that permits states nothing can create is documentation of an
  -- intention, not a constraint.
  status text not null default 'active'
    check (status in ('active', 'unsubscribed')),

  -- Where they signed up, accumulated. The KV writer unions new sources into
  -- the existing array rather than overwriting, so a person who subscribed
  -- from the footer and later from a product page carries both.
  sources text[] not null default '{}',

  -- What they said they cared about, accumulated the same way.
  interests text[] not null default '{}',

  -- product slug -> ISO timestamp of the announcement already sent. See the
  -- header note on why this is a map and not a table.
  notified_slugs jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One subscription per address per tenant. The KV hash was keyed by email,
  -- so this is the same guarantee, now enforced by the database instead of by
  -- the shape of the key.
  unique (tenant_id, email)
);

-- The admin list is "everyone, newest activity first", and the send path is
-- "every active subscriber for this tenant". Both are tenant-scoped scans, so
-- the index is on (tenant_id, updated_at) rather than on email, which is
-- already covered by the unique constraint above.
create index if not exists alert_subscribers_tenant_updated_idx
  on public.alert_subscribers (tenant_id, updated_at desc);

create index if not exists alert_subscribers_tenant_status_idx
  on public.alert_subscribers (tenant_id, status);

drop trigger if exists alert_subscribers_set_updated_at on public.alert_subscribers;
create trigger alert_subscribers_set_updated_at before update on public.alert_subscribers
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Same admin-tier shape as waitlist_entries/drop_draws (00012): tenant admins
-- manage, nothing is exposed to the anon/authenticated PostgREST surface, and
-- the app's own service-role-backed routes are the only writers.
--
-- This matters more here than for most tables: a subscriber list is a list of
-- email addresses belonging to people who did not consent to it being public.
alter table public.alert_subscribers enable row level security;

drop policy if exists "alert_subscribers_all" on public.alert_subscribers;
create policy "alert_subscribers_all" on public.alert_subscribers
  for all
  using (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant())
  with check (public.current_user_is_super_admin() or tenant_id = public.current_user_tenant());

comment on table public.alert_subscribers is
  'Drop-alert / release-announcement subscribers. One row per email per tenant. Distinct from waitlist_entries, which is a per-VARIANT restock queue — see this migration''s header for why they are not the same table.';
comment on column public.alert_subscribers.notified_slugs is
  'Product slug -> ISO timestamp of the release announcement already sent, so a subscriber is never emailed twice about the same product.';
comment on column public.alert_subscribers.status is
  'active | unsubscribed. Removal from the admin panel deletes the row outright; this column exists for a soft unsubscribe the read path already honours.';
