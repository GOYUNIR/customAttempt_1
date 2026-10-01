-- 00044 — remove two signup policies nothing reads any more (owner-approved
-- 2026-10-01). Signup's email budget is now its share of each provider's
-- DAILY limit (email.signup_daily_share_percent, 00042), enforced by the
-- governed email driver; these two were the old daily cap and monthly reserve.
delete from public.platform_policies where key in ('signup.daily_email_cap', 'signup.email_headroom_reserve_percent');
