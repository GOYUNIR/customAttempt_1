-- 00020_checkout_mode_case.sql
--
-- 00019 declared products.checkout_mode as ('RAFFLE','FCFS') without checking
-- that 00012 had already established lowercase ('fcfs','raffle','waitlist') on
-- product_variants. Two casings for one logical field, which made a single
-- product write violate one constraint or the other no matter the casing.
-- 00012 came first and includes 'waitlist', so products conforms to it.
--
-- STATEMENT ORDER MATTERS, and this is the order that actually works:
--
--   1. DROP the old constraint
--   2. UPDATE the existing data
--   3. ADD the new constraint
--
-- The first draft of this file ran UPDATE before DROP and failed with 23514:
-- the old uppercase-only constraint was still enforced, so it rejected the
-- lowercase value the UPDATE was writing. Adding the new constraint before
-- the UPDATE fails too, for the mirror reason — the old rows still hold
-- uppercase. Only drop -> update -> add satisfies both ends.
--
-- Generalised: when one migration changes BOTH a constraint and the data it
-- governs, always drop the constraint, migrate the data, then add the new
-- constraint. A constraint is enforced for the whole statement, including the
-- statement that is trying to make the data conform to its replacement.

alter table public.products
  drop constraint if exists products_checkout_mode_check;

update public.products
   set checkout_mode = lower(checkout_mode)
 where checkout_mode is not null;

alter table public.products
  add constraint products_checkout_mode_check
  check (checkout_mode is null or checkout_mode in ('fcfs', 'raffle', 'waitlist'));
