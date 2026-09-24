-- ─────────────────────────────────────────────────────────────────────────────
-- 00033 — each merchant gets their own Stripe account (Connect).
--
-- Design: CONNECT.md. Today every tenant charges through ONE Stripe account
-- (global_platform_settings.payment_api_key), so a second merchant's customers
-- would pay the platform, not the merchant. Connect is what makes
-- multi-merchant selling legal; no new merchant is onboarded until it ships
-- (owner, STRATEGY §9).
--
-- The live `tenants` table was probed first: no Stripe or fee columns existed.
--
-- WHAT A ROW MEANS
--   stripe_account_id            the merchant's connected account (Accounts
--                                v2). Unique: one Stripe account belongs to
--                                exactly one tenant, ever.
--   connect_charges_enabled      Stripe says this account may take card
--                                payments now. The checkout gate reads this
--                                and nothing else (lib/connect.ts).
--   connect_payouts_enabled      payouts to the merchant's bank are live.
--   connect_requirements         what Stripe still needs, for the onboarding
--                                panel — display only, never a gate.
--   connect_synced_at            when the three fields above were last
--                                copied from Stripe (the account.updated
--                                webhook, or an explicit sync).
--   platform_fee_bps_override    a negotiated rate (Scale). NULL = the plan's
--                                terms, including graduation.
--
-- These columns are a CACHE of Stripe's answer, refreshed from Stripe; Stripe
-- remains the authority. They exist so a checkout does not have to call Stripe
-- to ask whether it may take money — and they fail closed: a tenant with no
-- row values yet cannot charge through Connect.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tenants
  add column if not exists stripe_account_id text,
  add column if not exists connect_charges_enabled boolean not null default false,
  add column if not exists connect_payouts_enabled boolean not null default false,
  add column if not exists connect_requirements jsonb not null default '{}'::jsonb,
  add column if not exists connect_synced_at timestamptz,
  add column if not exists platform_fee_bps_override integer
    check (platform_fee_bps_override is null or platform_fee_bps_override between 0 and 10000);

-- One Stripe account, one tenant. Partial: most tenants have none yet.
create unique index if not exists tenants_stripe_account_unique
  on public.tenants (stripe_account_id)
  where stripe_account_id is not null;

-- A Stripe account id looks like acct_… ; anything else is a bug upstream.
alter table public.tenants drop constraint if exists tenants_stripe_account_format;
alter table public.tenants add constraint tenants_stripe_account_format
  check (stripe_account_id is null or stripe_account_id ~ '^acct_[A-Za-z0-9]+$');

-- Charges cannot be enabled on an account that does not exist.
alter table public.tenants drop constraint if exists tenants_connect_needs_account;
alter table public.tenants add constraint tenants_connect_needs_account
  check (stripe_account_id is not null or (not connect_charges_enabled and not connect_payouts_enabled));
