# Launch-state cleanup (DESTRUCTIVE: for the owner's approval, NOT run)

Inventory of production on 2026-10-01 (read-only scan):

| Store | Slug | Orders | Customers | Products | Users | Invites | Raffle entries | What it is |
|---|---|---|---|---|---|---|---|---|
| GOYUNIR | goyunir (default) | 6 | 6 | 3 | 0 | 4 | 0 | **Keep.** Its 6 orders are all proof purchases ($1.00 each, 2026-09-27, `@resend.dev` customers). |
| Demo Parfums | demo | 2 | 2 | 4 | 1 | 1 | 0 | **Keep.** Its 2 orders are proof purchases ($19.00, 2026-09-30, `@resend.dev`). |
| test4 | test4 | 32 | 37 | 5 | 1 | 40 | 20 | Proof fixture (Connect test account). |
| goyunir test 1 | goyunir-test-1 | 0 | 0 | 28 | 1 | 1 | 0 | Proof fixture ("store B" in the isolation proofs). |

Also in production:
- 169 `merchant_signups` (119 `@resend.dev`, 53 `@proof.goyunir.com`), all from proof runs. They hold store names until they expire.
- 72 `email_sink` rows (proof mail that was recorded, never sent).
- 2 accounts without a store, both proof leftovers:
  - `d…@resend.dev`, from a simulation run that crashed;
  - an `e…@proof.goyunir.com` temporary account, which the signup simulation deletes when it finishes.
- `usage_events` rows with provider `sink` (proof mail, cost 0).
- R2 objects under `tenants/<test4>/` and `tenants/<goyunir-test-1>/`, plus proof uploads under the kept stores.

## Decision needed before running: the two fixture stores

The release gate's purchase, fulfilment, export and isolation proofs run on test4 and goyunir-test-1 in **Stripe test mode**. Once the platform switches to live keys, production can no longer take test payments, so those proofs cannot run against production at all.

**Recommended:**
1. **At launch,** delete both fixtures (block C below).
2. **After launch,** run the gate against a free staging copy:
   - a second Worker on `workers.dev`;
   - a second Supabase project (the free plan allows 2);
   - Stripe test keys.

   That's about half a day of work, logged in RELEASE-PLAN.md (post-launch).

**The alternative** is to keep the fixtures, hidden. Not recommended: they are publicly reachable store addresses with test data.

## The SQL (one transaction; preview counts first)

Run it in the Supabase SQL editor. Run the PREVIEW block first and compare its counts with the table above; only then run the APPLY block.

```sql
-- ── PREVIEW (read-only) ─────────────────────────────────────────────────────
with proof_orders as (
  select o.id, o.stripe_payment_intent_id from orders o join customers c on c.id = o.customer_id
  where o.tenant_id in ('00000000-0000-0000-0000-00000000000d', '3b6f7db1-7645-4c52-aefe-cc8be563c359')
    and (c.email like '%@resend.dev' or c.email like '%@proof.goyunir.com' or c.email like '%.invalid')
)
select
  (select count(*) from proof_orders) as kept_store_proof_orders,                       -- expect 8
  (select count(*) from tenant_billing_charges where payment_intent_id in (select stripe_payment_intent_id from proof_orders)) as their_billing_rows,
  (select count(*) from customers where tenant_id in ('00000000-0000-0000-0000-00000000000d', '3b6f7db1-7645-4c52-aefe-cc8be563c359')
     and (email like '%@resend.dev' or email like '%@proof.goyunir.com' or email like '%.invalid')) as kept_store_proof_customers,  -- expect 8
  (select count(*) from merchant_signups where email like '%@resend.dev' or email like '%@proof.goyunir.com' or email like '%.invalid') as proof_signups,  -- expect 169
  (select count(*) from email_sink) as sink_rows,
  (select count(*) from users where tenant_id is null and (email like '%@resend.dev' or email like '%@proof.goyunir.com' or email like '%.invalid')) as orphan_proof_users;

-- ── APPLY (A: always; B: proof data in the kept stores; C: fixtures, if decided) ──
begin;
-- A. proof leftovers with no store
delete from merchant_signups where email like '%@resend.dev' or email like '%@proof.goyunir.com' or email like '%.invalid';
delete from email_sink;
delete from usage_events where provider = 'sink';
delete from email_send_counts where provider = 'sink';
-- (auth accounts: delete these users in Supabase → Authentication too; listed by the preview)
delete from users where tenant_id is null and (email like '%@resend.dev' or email like '%@proof.goyunir.com' or email like '%.invalid');

-- B. proof purchases in GOYUNIR and Demo Parfums (their billing rows first:
--    billing keeps a row when its order goes, and it counts toward the month's fee)
delete from tenant_billing_charges where payment_intent_id in (
  select o.stripe_payment_intent_id from orders o join customers c on c.id = o.customer_id
  where o.tenant_id in ('00000000-0000-0000-0000-00000000000d', '3b6f7db1-7645-4c52-aefe-cc8be563c359')
    and (c.email like '%@resend.dev' or c.email like '%@proof.goyunir.com' or c.email like '%.invalid'));
delete from orders where id in (
  select o.id from orders o join customers c on c.id = o.customer_id
  where o.tenant_id in ('00000000-0000-0000-0000-00000000000d', '3b6f7db1-7645-4c52-aefe-cc8be563c359')
    and (c.email like '%@resend.dev' or c.email like '%@proof.goyunir.com' or c.email like '%.invalid'));
delete from customers where tenant_id in ('00000000-0000-0000-0000-00000000000d', '3b6f7db1-7645-4c52-aefe-cc8be563c359')
  and (email like '%@resend.dev' or email like '%@proof.goyunir.com' or email like '%.invalid');

-- C. the two fixture stores (ONLY if decided above). Everything with
--    tenant_id ... on delete cascade goes with them (orders, customers,
--    products, stock, entries, invites, fulfilments, billing); audit rows keep
--    their history with the store id set to null. Their staff accounts first.
-- delete from users where tenant_id in ('13591c9e-82e4-4c23-8d94-249cef6fa775', 'ff8d5e59-1a07-4e83-bc13-f949c745d9de');
-- delete from tenants where id in ('13591c9e-82e4-4c23-8d94-249cef6fa775', 'ff8d5e59-1a07-4e83-bc13-f949c745d9de');
commit;
```

Afterwards, outside the database:
- **Supabase → Authentication:** delete the proof auth users listed by the preview, plus the two fixture owners if C ran.
- **R2:** delete `tenants/13591c9e…/` and `tenants/ff8d5e59…/` if C ran. I'll write a listing script and show you the object list first.
- **Stripe (test mode):** nothing to do. Live mode starts empty.
- **Re-run** `verify-merchant-isolation.ts` on whatever remains, plus the kept stores' storefront checks.
