-- ─────────────────────────────────────────────────────────────────────────────
-- 00035 — where a raffle/waitlist entry's saved card lives, and which kind of
-- entry it is (TENANCY.md phase 4, CONNECT.md §4 cutover rule).
--
-- stripe_account  The Stripe account the entry's saved card was saved ON.
--                 NULL = the platform account, which is where every entry that
--                 exists today was saved, so no existing row changes meaning.
--                 A card can only be charged on the account it lives on, so
--                 every off-session charge of a saved card is made on THIS
--                 account — never on whatever the store routes to today. That
--                 is what lets the original store switch to its own connected
--                 account later without stranding entries saved before it.
-- entry_type      'raffle' (drawn at random) or 'waitlist' (converted first
--                 come, first served when the product goes on sale). Default
--                 'raffle': every existing row is a raffle entry.
--
-- Additive and nullable/defaulted: safe to apply with the app running. The app
-- refuses merchant raffle and waitlist entries until both columns exist, so no
-- card is ever saved without its account being recorded.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.raffle_entries
  add column if not exists stripe_account text;

alter table public.raffle_entries drop constraint if exists raffle_entries_stripe_account_format;
alter table public.raffle_entries add constraint raffle_entries_stripe_account_format
  check (stripe_account is null or stripe_account ~ '^acct_[A-Za-z0-9]+$');

alter table public.raffle_entries
  add column if not exists entry_type text not null default 'raffle';

alter table public.raffle_entries drop constraint if exists raffle_entries_entry_type_check;
alter table public.raffle_entries add constraint raffle_entries_entry_type_check
  check (entry_type in ('raffle', 'waitlist'));

-- Waitlist conversion reads pending entries oldest first, per variant.
create index if not exists raffle_entries_variant_pending_submitted_idx
  on public.raffle_entries (variant_id, submitted_at)
  where status = 'pending';
