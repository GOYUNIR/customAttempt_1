-- 00022 — loyalty, consent and role on the customer record.
--
-- store:users bundles four unrelated concerns in one KV blob: authentication
-- (password, emailVerified), loyalty (rewards), consent (emailOptIn,
-- termsAgreedAt) and authorization (role). public.customers had a home for
-- none of them.
--
-- Three of the four move here. Authentication deliberately does NOT — see
-- DEFERRED-6 in ARCHITECTURE.md: moving storefront login to Supabase Auth is
-- customer-facing work (password reset, session handling, managed email
-- verification) that deserves its own phase rather than being folded into a
-- storage migration.
--
-- What moves, and why it cannot wait: a reactivation campaign needs opt-in
-- status and loyalty balance; compliance needs consent records with their
-- timestamps; the merchant panel needs role. Leaving these in a KV blob keyed
-- by an internal user id blocks all of it.

alter table public.customers
  -- Loyalty points balance. Integer, never negative: a redemption that would
  -- overdraw must fail, not wrap into a negative balance that later reads as
  -- credit. lib/customer-profile.ts enforces this with a compare-and-swap so
  -- two concurrent redemptions cannot both spend the same points.
  add column if not exists rewards_balance integer not null default 0
    check (rewards_balance >= 0),

  -- Marketing consent. NULL means "never asked", which is deliberately
  -- distinguishable from false ("asked, declined") — the two are different
  -- for compliance and for whether a campaign may include this person.
  add column if not exists email_opt_in boolean,

  -- When the customer agreed to terms. A timestamp rather than a boolean so
  -- the record says WHICH terms they accepted, by when.
  add column if not exists terms_agreed_at timestamptz,

  add column if not exists role text not null default 'customer'
    check (role in ('customer', 'vip', 'wholesale', 'banned'));

-- Campaign segmentation reads these together: "opted-in customers with a
-- balance", "everyone who never answered". Indexed for that access pattern
-- rather than for point lookups, which go through (tenant_id, email).
create index if not exists customers_tenant_optin_idx
  on public.customers (tenant_id, email_opt_in);
create index if not exists customers_tenant_role_idx
  on public.customers (tenant_id, role);

comment on column public.customers.rewards_balance is
  'Loyalty points. Authoritative; the KV store:users copy is display-only until the bridge is removed. Changed only through lib/customer-profile.ts adjustRewards, which uses a compare-and-swap.';
comment on column public.customers.email_opt_in is
  'Marketing consent. NULL = never asked, false = declined, true = opted in. The NULL/false distinction is intentional.';
