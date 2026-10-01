# Discount codes for merchant stores (SCOPE ONLY, not built)

Status 2026-10-01: design for the owner's decisions. Nothing here is built.
Today a merchant store refuses any promo code at checkout ("Promo codes aren't
available in this store yet", `lib/tenant-checkout.ts`). The original store's
promo codes live in global KV and are a separate, older system; they are not
reused here.

## What a merchant can make (v1)

| Field | Meaning | Default |
|---|---|---|
| Code | 4–24 letters, digits, dashes; case-insensitive; unique within the store | required |
| Type | **Percent** off (1–90%) or **fixed amount** off (in the store's currency) | required |
| Minimum order | Subtotal before the discount must reach this | none |
| Starts / ends | Valid from / until (UTC) | now / no end |
| Total uses | Redemptions across all customers | unlimited |
| Uses per customer | Per checkout email | 1 |
| Active | Switch off without deleting | on |

The dashboard shows Code, Type and Amount; the rest sit behind "More options"
(Hick's Law: most codes need three fields).

## How a code applies at checkout

1. The buyer types a code on our storefront before going to Stripe. The server
   looks it up by **(this store from the Host header, code)**, never by code
   alone, and checks the dates, the minimum, the limits and the floor (below).
2. **Recommended mechanism (decision 1): we compute the discount and send Stripe
   the reduced prices.** The Checkout Session is created on the merchant's own
   account (direct charge) with each line's `unit_amount` already reduced, and
   the line name carries the code ("Speckled Mug · code SPRING10"). So:
   - our code is the one source of truth;
   - `amount_total` is known exactly before the session exists, so
     `application_fee_amount` is computed on the real total;
   - carts work the same way as single items;
   - there are no Stripe coupon objects to keep in sync on every merchant's
     account.
   - The alternative is Stripe Coupons and Promotion Codes, created on each
     connected account and passed as `discounts`. Stripe's page then shows a
     "discount" line, but each code must be mirrored and kept in sync per
     account. Stripe's own `allow_promotion_codes` is ruled out either way: we
     would not know the total when we fix our fee.
3. **Fixed-amount codes on carts:** the amount is spread across lines in
   proportion to line value, rounded to the cent. The last line takes the
   remainder, so the lines add up exactly.
4. **The floor:** a discount never takes the total below Stripe's minimum
   charge ($0.50 or the currency's equivalent). That rules out free orders in
   v1, because Checkout in payment mode cannot charge 0.
5. **One code per order** (no stacking) in v1.
6. **Limits under concurrency:** a code with a use limit is reserved when
   checkout starts, like stock holds (00037). The reservation is held for the
   checkout's hold time, turned into a redemption by the payment webhook, and
   released when the session expires. Without this, 20 parallel checkouts
   could each pass a "first 10 customers" check.
7. **The order records it:** `orders.discount_cents` (already a column) holds
   the amount, and `metadata.discountCode` holds the code. The order
   confirmation email and the order detail page show "Discount (CODE)".

## Our fee (decision 2)

**Recommended: our fee is computed on the discounted total**, which is what the
buyer actually pays and what the merchant actually receives. That is also what
Stripe charges, and our month's volume already uses "what Stripe charged"
(PRICING.md §6), so nothing new is needed. Computing the fee on the list price
would charge merchants a fee on money they never received.

## Refunds (decision 3)

- A refund of a discounted order refunds what was paid (the merchant does it
  in Stripe, as today). Our fee comes back in proportion (D5, unchanged).
- **Recommended: a refund does NOT give the code's use back.** Otherwise
  "buy, refund, buy again" repeats a one-per-customer code. A merchant who
  wants to be generous can raise the limit.

## Abuse

- **Guessing codes:** the "apply code" check is rate-limited per IP and per
  store. A wrong code gets one generic answer ("That code isn't valid"), the
  same whether the code is unknown, expired or used up, so nobody can probe
  which codes exist. The minimum length is 4.
- **Per-customer limits** key on the checkout email (lowercased). Someone
  using many emails gets around a per-customer limit. That is accepted for v1;
  the total-uses limit still bounds the cost.
- **No negative or zero totals:** the floor above.
- **Raffles and waitlists (decision 4): recommended NOT in v1.** The price is
  part of a fair entry, and the charge happens later, when the code may have
  expired.
- **Leaked codes:** the merchant can switch a code off instantly; usage shows
  per code.

## Isolation (every route proven, like all merchant routes)

- Data: `discount_codes (tenant_id, code, …)` is unique on
  `(tenant_id, lower(code))`, so the same word in two stores means two
  separate codes. `discount_redemptions (tenant_id, code_id, order_id, email,
  amount_cents, status held|redeemed|released, hold_key)`.
- Merchant CRUD lives under `/api/merchant/discounts`, behind `merchantSession`
  (structural test), with the store taken from the session. Applying a code is
  storefront-side and uses the store from the Host header.
- Proof: store B cannot list, read, edit or switch off store A's codes. A's
  code typed on B's storefront is "not valid". B's redemptions never count
  against A's limits. Usage limits hold under 20 parallel checkouts. The fee
  is on the discounted total, checked against Stripe's own
  `application_fee_amount`.

## Decisions for the owner

1. **Mechanism:** reduced prices computed by us (recommended), or Stripe
   Coupons mirrored per merchant account?
2. **Fee basis:** on the discounted total (recommended)?
3. **Refunds:** keep the use consumed (recommended)?
4. **Raffles and waitlists:** excluded from v1 (recommended)?
5. **Plans:** codes on every plan, with a cap on active codes as plan data
   (suggested Free 3, Starter 10, Growth and Scale unlimited)? Or a paid-plan
   feature only?
6. **Scope:** whole-order codes only in v1 (recommended), with product- or
   collection-specific codes in v2?
7. **Percent cap:** at most 90% (recommended), or allow up to the $0.50
   floor?
