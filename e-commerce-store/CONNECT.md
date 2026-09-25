# CONNECT — every merchant gets their own Stripe account

> ## ▶ RESUME HERE (updated 2026-09-25)
>
> **Connect is still NOT enabled on the Stripe account this app uses.**
> Probed 2026-09-25 against `acct_1ToixCPIsR6ijfBZ` (the account behind the
> configured key). With valid parameters, Stripe answers: *"You can only
> create new accounts if you've signed up for Connect."* The owner believed
> Connect was on, so it was most likely enabled in a different sandbox, or
> the platform-setup flow wasn't finished. **Re-probed later the same day,
> after the mobile work: unchanged** (`verify-connect-account.ts` returned
> "Accounts v2 is not enabled" on both concurrent calls, 0 accounts created).
> Stripe's error also offers enabling Connect from the Stripe CLI/MCP. Not
> done here: it changes the owner's Stripe account. Owner actions, both on
> `acct_1ToixCPIsR6ijfBZ`:
> 1. Finish Connect platform setup:
>    <https://dashboard.stripe.com/acct_1ToixCPIsR6ijfBZ/settings/connect/platform-setup>
>    (the link from Stripe's own error message).
> 2. Enable **Accounts v2**. The v2 create returned *"Accounts v2 is not
>    enabled for your sandbox merchant"*, pointing to
>    <https://docs.stripe.com/accounts-v2/use-accounts-as-customers>.
>
> **The approved shape changed on one field.** `dashboard: express` is
> refused with merchant liability. Stripe: *"When
> stripe_dashboard[type]=express, your platform must collect fees and be
> liable for negative balances."* The default is now `dashboard: full`: the
> merchant's own full Stripe Dashboard, matching the pricing-page promise
> "Your own Stripe account". Liability stays on the merchant. **Not yet
> proven:** that Stripe accepts full + `fees_collector: stripe` +
> `losses_collector: stripe`. The probe for it hit the Connect-not-enabled
> wall. Confirm it first, once Connect is on.
>
> **Built and deployed (2026-09-25), not registered:**
> - `app/api/stripe/connect-webhook` handles `account.updated` by syncing
>   from Stripe, with the cross-tenant guard (5 tests). Payment events answer
>   500 and are released until their handler exists.
> - Migration `00034` adds `payment_connect_webhook_secret` to
>   `global_platform_settings` (owner applies).
> - With no secret configured the route answers **503** to everything, so
>   nothing is accepted unsigned and Stripe retries once the secret is set.
>
> **Next, in order:**
> 1. The owner does the two actions above and applies `00034`.
> 2. Run `npx tsx scripts/verify-connect-account.ts` (`test4`, two concurrent calls,
>    expect one account).
> 3. With owner confirmation, register the Connect endpoint
>    (`https://goyunir.com/api/stripe/connect-webhook`, `connect: true`,
>    event `account.updated`), then store its signing secret in
>    `global_platform_settings.payment_connect_webhook_secret`.
> 4. Onboard `test4` (embedded component, or Stripe's test data). Expect
>    `account.updated` to flip `connect_charges_enabled`.
> 5. CONNECT.md §8 step 4: the fee wired into each charge path.

Status (2026-09-24): **groundwork only.**

- **Built:** migration `00033`; the routing rule and status mapping
  (`lib/connect-routing.ts`, with 4 tests); and account creation, embedded
  onboarding and status sync (`lib/connect.ts`). All of it is typechecked
  against the Stripe SDK's own types.
- **Not built:** nothing charges through Connect yet.
- **Blocked on the owner:** Stripe refuses to create connected accounts until
  Connect is enabled on the platform account (§1).

Why this matters: today every tenant charges through **one** Stripe account.
A second merchant's customers would be paying the platform. Connect is what
makes multi-merchant selling legal. No new merchant is onboarded until it
ships (STRATEGY §9).

---

## 1. What the owner has to do first

1. **Enable Connect** at <https://dashboard.stripe.com/connect> (test mode is
   enough to start). Probed 2026-09-24, Stripe answered: *"You can only create
   new accounts if you've signed up for Connect."*
2. **Platform profile:** a software platform whose merchants sell their own
   goods to their own customers, with **Stripe handling pricing for your
   users** (§2 explains why).
3. **Apply `00033`.** The Connect webhook endpoint (§5) is registered after
   that. It is a change to the live Stripe account, so I'll confirm before
   registering it.

## 2. The shape — corrected from the plan approved earlier

The earlier plan said: Express accounts, **destination charges** with
`on_behalf_of`, "chargebacks to them". Stripe's documentation contradicts the
part that mattered most:

> "For disputes where payments were created on your platform using
> destination charges … **with or without `on_behalf_of`, your platform
> balance is automatically debited** for the disputed amount and fee."
> Refunds on destination charges likewise "debit your platform balance."

`on_behalf_of` changes the settlement country, the fee schedule and the
statement descriptor. It does **not** move liability. So the corrected shape
follows Stripe's own recommendation for SaaS platforms, where it names Shopify
as the example:

| Choice | Value | Why |
|---|---|---|
| Account API | **Accounts v2** | Stripe recommends it for new platforms. Stripe says direct charges "aren't recommended for legacy v1 Express and Custom accounts". The installed SDK (22.3.2, API `2026-06-24.dahlia`, generally available) supports it. |
| Charge type | **Direct charges** | The charge is made on the merchant's account. "Refunds and chargebacks reduce the connected account's balance." The platform's cut is `application_fee_amount`. |
| `losses_collector` | **`stripe`** | "Stripe is liable for the connected account's negative balances." The platform isn't. |
| `fees_collector` | **`stripe`** | Stripe bills the merchant its processing fee directly, so `application_fee_amount` is **only our fee**: exactly what `lib/pricing/graduated-fee.ts` computes. |
| Platform cost | **$0** | With Stripe handling pricing there are "no additional account, payout volume, tax reporting, or per-payout fees". The alternative is $2 per active merchant per month plus 0.25% + 25¢ per payout, which would take about a third of what we earn from a $500-a-month Free merchant. |
| KYC | **Stripe collects it** | Automatic with `losses_collector: stripe`. We carry no identity-verification compliance burden. |
| `dashboard` | **`full`** (changed 2026-09-25) | The merchant's own full Stripe Dashboard, matching the pricing-page promise "Your own Stripe account". **Not `express`:** Stripe refuses Express unless the platform collects fees and carries losses. Onboarding stays embedded in the merchant app. |

**Irreversible per account:** Stripe says responsibilities "can't be updated
later". Every account created from `CONNECT_ACCOUNT_DEFAULTS` carries these
settings for life, which is why they're decided here rather than in a
checkout route.

## 3. The routing rule (`lib/connect-routing.ts`, tested)

- A merchant whose connected account Stripe has **enabled for card payments**
  is charged on their own account (a direct charge).
- The **legacy platform tenant** (the one store that predates Connect) keeps
  charging on the platform account until its own connected account is
  enabled. It is the only tenant that may ever do that.
- **Everyone else is refused** until onboarding completes. This fails closed:
  a missing, malformed or stale account reads as "no", never as "use the
  platform account".

The "enabled" flag is a cache of Stripe's answer, stored on the tenant row
(`00033`) so checkout doesn't have to call Stripe to ask. It is refreshed by
the `account.updated` webhook. Stripe remains the authority.

## 4. What each charge path becomes

Every Stripe call for a connected merchant carries `{ stripeAccount }`.
Idempotency keys gain the account id, so a key can never collide across
merchants.

| Path | Under Connect |
|---|---|
| `checkout/direct` (PaymentIntent) | PaymentIntent on the merchant's account, with `application_fee_amount` from `platformFeeForCharge`. The Customer is created on the merchant's account too. |
| `checkout/cart` (Checkout Session) | Session on the merchant's account, with `payment_intent_data.application_fee_amount`. |
| Raffle entry (`mode: setup`) | Session on the merchant's account, so **the saved card lives on the merchant's account**. |
| Auto-draw, admin trigger-drop, waitlist (off-session) | PaymentIntent on the merchant's account, using the entry's customer and card, which live there too, with the application fee. |
| Refunds (D5) | On the merchant's account, with `refund_application_fee: true`, so our fee on that sale is returned exactly. Then `setBillingRefund`. |

**The legacy tenant's cutover has one trap.** Cards saved before the switch
live on the *platform* account, and a card can't be charged on a different
account without cloning it. The legacy tenant should therefore switch only
between drops, with no open raffle pools. Pools still open at the switch are
charged on the account where their cards were saved. The draw code has to
route by where the entry's card lives, not by the tenant's current state. I'll
design that with the path changes, not bolt it on.

## 5. Webhooks

- Events from direct charges happen **on the merchant's account**, so they
  arrive at a **Connect** webhook endpoint (registered with `connect: true`,
  and with its own signing secret), carrying `event.account`.
- The handler resolves the tenant **from `event.account`**. If the session's
  own metadata names a different tenant, it refuses to act. That guard stops
  one merchant's event from ever touching another merchant's orders or stock.
- The existing platform endpoint keeps serving the legacy tenant.
- `account.updated` calls `syncConnectedAccount`. That is what flips
  `charges_enabled` when a merchant finishes onboarding. Without it, the
  deferred onboarding never completes.
- On `checkout.session.completed` and `payment_intent.succeeded`, the order
  write stays first, and `recordBillingCharge` records the sale and its fee in
  the running monthly total (PRICING.md §6), idempotent per PaymentIntent.
- Dedupe keeps using `webhook_dedupe`. Stripe object ids are globally unique,
  so no tenant scope is needed.

## 6. Onboarding (merchant app)

- Stripe's embedded `account_onboarding` component (`@stripe/connect-js`, free)
  renders inside the merchant app, fed by `createOnboardingSession`. The
  merchant never leaves our domain; Stripe collects and verifies the details.
- The panel shows three states only:
  - **not started** (a button that creates the account);
  - **Stripe needs more** (the embedded component);
  - **"You can take payments"**.
- The merchant can build the whole store before onboarding. Only the checkout
  button is gated.

## 7. How it gets verified (once §1 is done)

Same standard as every money-path change: real test-mode activity, read back
from Stripe's API and the database.

1. Create a test v2 account through `ensureConnectedAccount` twice at once.
   Expect **one** account.
2. Onboard it with Stripe's test data. Expect `account.updated` to flip
   `connect_charges_enabled`.
3. Make a real test charge on **each** path, then check:
   - the charge is on the merchant's account;
   - the `application_fee` equals the graduated fee;
   - the order row carries `platform_fee_cents`;
   - `tenant_billing_charges` has exactly one row for it.
4. Refund one sale. Expect the fee returned exactly and the month's volume to
   fall by the sale.
5. **Dispute test card** (`4000000000000259`). Expect the disputed amount to
   come off the **merchant's** balance, not the platform's. This is the
   liability claim, proven rather than asserted.
6. An unconnected second tenant tries to check out. Expect it to be refused,
   with no charge anywhere.

## 8. Order of work

1. **Done:** `00033`, the routing rule, account, onboarding and status sync.
2. **Owner:** §1.
3. `account.updated` plus the Connect webhook endpoint, and the tenant guard.
4. `platformFeeForCharge` wired into each path, one path per change, each
   verified per §7. Direct and cart first, then setup and draws with the
   cutover rule.
5. The onboarding panel.
6. The pricing page flips with it (DEFERRED-9, PRICING.md §8): fees are
   charged from the moment Connect goes live, never before.
