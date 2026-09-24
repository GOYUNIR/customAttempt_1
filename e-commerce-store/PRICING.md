# PRICING — the graduated platform fee

Design for STRATEGY.md §5's graduated model. Status (2026-09-24):

- **Built:** the fee engine (`lib/pricing/graduated-fee.ts`) with 10 tests, and
  the per-plan fee rates as pricing data (`platformFeeBps` in
  `lib/platform-marketing.ts`).
- **Not built:** collection. The fee is taken through Stripe Connect, so it
  ships with Connect.
- **Needs the owner:** the five decisions in §5 below.

---

## 1. The promise

> **You never pay more than the cheapest plan would have cost for the month
> you actually had. You never have to pick the right plan to get that.**

A Free merchant pays 2% of each sale. As the month's sales grow, the rate on
the *next* sale drops to 0.5%, then to 0%. It drops exactly when a paid plan
would have become the cheaper deal. A month never costs more than $99, and
there is nothing to switch, predict or regret.

## 2. The numbers

All of these come from the engine, using the decided plans: Free 2%, Starter
$29 + 0.5%, Growth $99 + 0%.

**The schedule:**

- **2%** on the first **$1,933.34** of sales in a month.
- **0.5%** from there to **$14,000**.
- **0%** after that: every further sale that month is fee-free.

**What a month costs:**

| Monthly sales | Fee | Effective rate | A flat 2% would be |
|---|---|---|---|
| $500 | $10.00 | 2.00% | $10.00 |
| $1,000 | $20.00 | 2.00% | $20.00 |
| $1,933 | $38.67 | 2.00% | $38.67 |
| $3,000 | $44.00 | 1.47% | $60.00 |
| $5,000 | $54.00 | 1.08% | $100.00 |
| $10,000 | $79.00 | 0.79% | $200.00 |
| $14,000 | $99.00 | 0.71% | $280.00 |
| $25,000 | $99.00 | 0.40% | $500.00 |
| $50,000 | $99.00 | 0.20% | $1,000.00 |

This is Stripe's fee to the merchant plus ours. We never touch Stripe's own
processing fee.

## 3. Why this mechanism

Each plan is a straight cost line against monthly volume: price + rate ×
sales. The graduated fee is the **lowest line at the volume actually done**.
Because the Free plan starts at $0, that lowest line starts at zero and only
ever flattens. One consequence makes the whole design practical:

**If each sale is charged the increase it causes in that lowest line, the
month's fees add up exactly to the cheapest plan for the month's total.** That
holds however the month was split into sales and in whatever order. The tests
check it across 500 random months.

So:

- **It can be collected sale by sale.** The fee is Stripe Connect's
  `application_fee_amount` on each charge. There is no end-of-month bill, and
  no "you overpaid, here's a credit" in the normal case.
- **The breakpoints are derived, never configured.** They are computed from
  the plan prices and rates. Change a price and they move. There is no second
  table to fall out of step.
- **It is exact integer money:** basis points and cents, never floats. Each
  fee is the difference of two rounded totals, which is what keeps the
  per-sale sum equal to the monthly total.

Alternatives I rejected:

- **A monthly fee cap at a plan's price.** Capping at $29 undercuts Starter.
  Capping at $99 still overcharges anyone between $1,933 and $14,000.
- **Billing the cheapest plan with an end-of-month true-up.** It gives the same
  totals, but it collects the wrong amount all month, refunds the difference
  later, and needs a billing run.
- **Hand-set tiers** (for example 2% / 1% / 0.5%). They're arbitrary, they
  drift from the published plans, and they can't honestly say "never more than
  the cheapest plan".

## 4. What the merchant sees

This is the "approaching milestone, not a sales push" card. `monthStanding()`
already returns every number in it.

- **Normal:** *"$1,500 in sales this month · 2% · $433.34 more and your rate
  drops to 0.5% on everything after."*
- **Past the first breakpoint:** *"Your rate this month is 0.5%. Effective
  rate so far: 1.47%."*
- **At the ceiling**, the one merchants screenshot: *"You've reached this
  month's maximum. Every sale until October 1 is fee-free."*
- **A monthly recap:** *"September: $18,420 in sales, $99 in fees, 0.54%. On a
  flat 2% you'd have paid $368.40."* This is always true, because it's the
  actual envelope, never a projection.

Tone: plain numbers, no upsell language. The only prompt ever shown is one
that's in the merchant's interest (see D3).

## 5. Decisions for the owner

These are product judgment calls where reasonable people would disagree, so I
haven't made them. Each has a recommendation.

**D1. The Free plan's 50-orders-a-month cap works against graduation.**

- With the cap, a Free merchant only reaches the 0.5% band with an average
  order above **$38.67**, and only reaches the fee-free point with an average
  order above **$280**. For most Free merchants, "graduated" would never
  visibly happen.
- The cap was set when Free earned nothing. It exists because every order
  sends transactional email from one shared allowance. At 2%, a Free merchant
  now pays for their own email many times over.
- **Recommendation:** drop the hard cap. Keep a high abuse ceiling that is not
  sold as a plan limit, sized against email cost (for example 1,000 orders a
  month, monitored).

**D2. With graduation, Starter is never the cheaper choice.**

- Graduated Free already costs the same as Starter in Starter's band, and less
  everywhere else.
- Starter's features are, by Free's own copy, "the same product".
- **Recommendation:** keep Starter's price as the middle band of the schedule,
  but stop selling it as a plan to choose. The pricing page becomes **Free
  (graduated) · Growth $99 · Scale**. The alternative is giving Starter
  features worth choosing it for, which is breadth the strategy says to avoid.

**D3. What happens at the $99 ceiling.**

- A Free merchant past $14,000 pays exactly what Growth costs, but without the
  growth modules.
- **Recommendation:** stay on Free, and show one prompt at that moment:
  *"You're paying the same as Growth this month. Switch and get the growth
  modules at no extra cost."* It's true, it's in their interest, and it's the
  only upgrade prompt the product ever shows.

**D4. When the month resets.**

- **Recommendation:** calendar month, UTC. It's simple to explain and to audit.
- The alternative is the merchant's local timezone, which is friendlier for
  the "fee-free until October 1" moment. It's cheap to do later if a merchant
  asks.

**D5. Refunds.**

- **Recommendation:** refunding a sale refunds exactly the fee taken on that
  sale (Stripe's `refund_application_fee`), and takes the amount off the
  month's running total.
- Rates on other sales are never recalculated after the fact.
- The fee is stored on each order, so this is exact.

## 6. Money-path rules (STRATEGY §4)

- **The fee is fixed when the charge is created.** Connect sets
  `application_fee_amount` on the PaymentIntent or Checkout Session, using the
  month's running total at that moment. The running total only advances when
  a payment actually succeeds (in the webhook), so an abandoned checkout never
  counts toward it.
- **A race can only ever overcharge, so it is refunded.** Two checkouts
  created from the same running total both pay as if the other hadn't
  happened. The only effect is a small overcollection when a breakpoint is
  crossed.
  - A **monthly reconciliation** compares what was collected with the month's
    true figure and refunds any excess (application-fee refunds).
  - It never charges more. This keeps "never more than the cheapest plan"
    exactly true, not approximately true.
- **The running total advances atomically.** It uses one SQL function that
  adds the amount and returns the before and after totals. It is never a
  read-then-write from application code: that is the lost-update pattern B3
  just removed from the webhook dedupe.
- **The fee is idempotent per payment**, keyed by the PaymentIntent. A retried
  webhook doesn't advance the total twice.
- **If the running total can't be read, charge no fee.** Log it, and let
  reconciliation settle it. Blocking a sale over a billing hiccup costs the
  merchant real money. Guessing a fee could overcharge them. A few cents of
  our own at risk is the right trade.

## 7. Data model (migration draft, not yet written as a file)

```sql
-- plans: the contract. Rates and prices move here from the shop window.
alter table public.plans
  add column platform_fee_bps integer check (platform_fee_bps between 0 and 10000),
  add column graduated boolean not null default false;  -- true for Free

-- which plan a tenant is on
alter table public.tenants
  add column plan_id text references public.plans (id) default 'free';

-- the month's running total, advanced atomically
create table public.tenant_billing_months (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  month date not null,                                   -- first day, UTC
  volume_cents bigint not null default 0 check (volume_cents >= 0),
  fees_collected_cents bigint not null default 0,
  primary key (tenant_id, month)
);
-- add_billing_volume(tenant, month, cents) returns (before, after):
--   insert ... on conflict do update set volume_cents = volume_cents + excluded
--   returning; one statement, no read-then-write.

-- what was charged, for refunds and reconciliation
alter table public.orders add column platform_fee_cents integer;
```

Seed rows for free, starter, growth and scale come from the published pricing
data. After that, `public.plans` is the source, and a test asserts it matches
`lib/platform-marketing.ts`.

## 8. Build order, after the decisions

1. **Migration**: the plans columns, tenant plan assignment, running totals,
   and the order fee column.
2. **Tenant plan assignment and the D1 order ceiling.** This replaces the
   unenforced "50 orders" copy.
3. **With Connect:** compute the fee when a charge is created, advance the
   running total in the webhook, store `platform_fee_cents` on the order.
4. **The monthly reconciliation job**, which refunds any overcollection.
5. **The merchant milestone card** (§4) and the monthly recap.
6. **The pricing page**:
   - state the fee schedule plainly;
   - keep the attribution-honesty promise as a separate sentence (DEFERRED-9);
   - reflect D2;
   - remove "shared stock pools" from Starter. The pools feature is refused at
     checkout until real pool support exists, so the page currently advertises
     something that doesn't work.

Items 1–2 can go ahead as soon as the decisions are made. Items 3–5 are part
of the Connect work.
