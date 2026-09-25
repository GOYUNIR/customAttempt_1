-- ─────────────────────────────────────────────────────────────────────────────
-- 00034 — where the Stripe Connect webhook's signing secret lives.
--
-- Connect events (account.updated, and every charge made directly on a
-- merchant's account) arrive at a SEPARATE webhook endpoint registered with
-- `connect: true`, which Stripe signs with its OWN secret — not the platform
-- endpoint's payment_webhook_secret. Same home as that one, for the same
-- reason: it can be set without a deploy, and the env var
-- STRIPE_CONNECT_WEBHOOK_SECRET remains the fallback, matching the pattern
-- resolvePaymentWebhookSecret already uses.
--
-- Nullable and unset: until the endpoint is registered (an owner-confirmed
-- change to the live Stripe account), app/api/stripe/connect-webhook rejects
-- every request rather than accepting unsigned events.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.global_platform_settings
  add column if not exists payment_connect_webhook_secret text;
