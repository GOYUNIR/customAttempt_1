-- 00021 — one durable customer record, linked to Stripe.
--
-- WHY: executeDrawWithCharging read raffle_entries.customer_id and handed it
-- to Stripe as `customer:`, but that column is a uuid FK to public.customers
-- while Stripe needs a `cus_…` id — and public.customers had nowhere to store
-- one. The only production writer of raffle_entries (the Stripe webhook)
-- therefore never set customer_id at all, so every winner declined as
-- `no_payment_method`. A Stripe test-mode dry run charged 0 of 3 winners while
-- the Redis engines charge them today.
--
-- The alternative was a `stripe_customer_ref text` on raffle_entries, next to
-- payment_method_ref. Rejected deliberately: this is a customer-identity
-- decision, not a charging one. CRM, automated follow-ups, reactivation and
-- referrals all need ONE durable record per person across raffles, FCFS and
-- future subscriptions. A Stripe ref scattered per entry gives the same
-- person entering three raffles no single identity to build history on.
-- Normalizing costs little now, while the data is disposable.

alter table public.customers
  add column if not exists stripe_customer_id text;

-- One customer row per Stripe customer, per tenant. Partial so the many rows
-- that legitimately have no Stripe customer yet (a B2B contact, an imported
-- record, a waitlist join) do not collide with each other on NULL.
create unique index if not exists customers_tenant_stripe_id_unique
  on public.customers (tenant_id, stripe_customer_id)
  where stripe_customer_id is not null;

-- Looking a customer up by their Stripe id happens on every raffle entry and
-- every charge, so it gets its own index rather than relying on the partial
-- unique one above.
create index if not exists customers_stripe_id_idx
  on public.customers (stripe_customer_id)
  where stripe_customer_id is not null;

comment on column public.customers.stripe_customer_id is
  'Stripe customer id (cus_…). The durable link between this platform''s customer record and Stripe. Charging paths resolve it through this row rather than storing a Stripe reference per entry/order.';
