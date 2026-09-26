# TENANCY — which store is this request for?

> ## ▶ RESUME HERE (2026-09-26, phase 4 proven live)
>
> **Phase 4 (merchant raffles + waitlists) is live and proven on test4**
> (`scripts/verify-tenant-drops.ts enter|draw`, 00035 applied by the owner).
>
> **ENTER:** five real card saves.
> - Three raffle entries: two 4242, one 4000…0341.
> - Two waitlist entries.
> - Each showed the right confirmation.
> - Each is recorded ONCE (the webhook and the confirm step both ran),
>   pending, on `acct_1UJWFxPIsRXBZjvC`, with its type, a `pm_…` and a
>   customer.
> - None of the cards exists on the platform account.
>
> **DRAW, first attempt: FAILED, and that found a real bug.** Every trigger
> hit "Too many subrequests by single Worker invocation" (free plan, 50
> calls). Four cards were charged, then the order, billing or stock writes
> died part-way.
> - A failed order write was only logged before the entry was marked
>   charged.
> - Stock was not repeatable on retry.
> - Both are fixed. The engine now spends a per-invocation call budget
>   (`WORKER_SUBREQUEST_LIMIT`, default 50), does only whole charges, and
>   reports `more`.
> - Every step after the charge throws on failure and is safe to repeat. The
>   entry is marked charged last.
> - Only a Stripe card error is a decline.
> - Test data was reconciled by hand: one completed stock claim for
>   raffle-a, standing for the single decrement that had already happened.
>
> **DRAW, resumed: ALL PASS.** Seven triggers, one charge each on the free
> plan; all worker invocations were clean in the logs.
> - Exactly one draw.
> - raffle-a and raffle-b: 3000, fee 60 each.
> - wait-a and wait-b: 1500, fee 30 each.
> - Every charge was on test4 only, with ONE PaymentIntent and one
>   successful charge per entry. The half-finished charges were REPAIRED,
>   not redone.
> - An order and one billing row for each.
> - The 0341 winner declined and is back in the pool.
> - Stock: raffle 3 → 1, preorder 5 → 3.
> - Nothing was written for the default store; a later trigger does nothing.
>
> **On the free plan a merchant draw completes about ONE charge per
> trigger.** The countdown and the scheduler keep triggering. Workers Paid
> (a go-live blocker already) makes one trigger handle ~35. Set
> `WORKER_SUBREQUEST_LIMIT=1000` when upgrading.
>
> **The original store stays on R1/R2** until the owner explicitly starts
> the cutover (owner, 2026-09-26). See the open question in CONNECT.md §4.
>
> **SECURITY, found and contained 2026-09-26:** the admin tree acted on the
> original store for ANY valid admin session. Proven read-only: test4's owner
> session listed the original store's products (HTTP 200). Contained at three
> layers (middleware, `adminAuthorized`, `resolveAdminActor`); verified live by
> `scripts/verify-admin-tenant-guard.ts`: the merchant session gets 403, the
> original store's own admin still gets 200. Staff impersonation of a merchant
> is refused with it.
>
> **Next, and the real gap:** the merchant dashboard, the admin tree resolving
> its tenant from the session. Merchant self-service comes before emails,
> legal pages and the rest.

> _Previous note (phase 4 deployed, before 00035):_
>
>
> **Phase 4 (merchant raffles and waitlists) is built and deployed**
> (`lib/tenant-drops.ts`). It is **closed at the door until the owner applies
> migration `00035`** (`raffle_entries.stripe_account` + `entry_type`).
> Verified on production:
> - test4's raffle entry answers "Raffle entries aren't open in this store yet".
> - test4's countdown trigger answers `skipped: "00035 not applied"`.
> - No card is saved without its account recorded.
>
> **Resume, in order:**
> 1. Owner applies `00035`.
> 2. `npx tsx scripts/verify-tenant-drops.ts enter`: real card saves on test4.
>    Three raffle entries (one with 4000…0341, which declines when charged)
>    and two waitlist entries, each checked as recorded with test4's account.
> 3. `npx tsx scripts/verify-tenant-drops.ts draw`: makes the raffle due and
>    the preorder live, fires two triggers at once, and checks:
>    - exactly one draw;
>    - two raffle charges and two waitlist charges on test4, each with our
>      fee, an order and one billing row;
>    - the 0341 winner back in the pool;
>    - stock down by four;
>    - a third trigger does nothing.
>
> Test products `connect-test-raffle` and `connect-test-preorder` are already
> in test4's catalog (`scripts/seed-tenant-drop-products.ts`).
>
> **The saved-card cutover rule** is built, tested and wired into every
> saved-card charge site. The rule and the ordered switch procedure for the
> original store are in CONNECT.md §4. The original store's behaviour today
> is identical:
> - its raffle entry still opens a card-save page on the platform (probe
>   session expired);
> - its buy journey passes at all three widths.
>
> **Not exercised live for the original store:** its draw engines with the
> new guard. Running a real draw there would charge the saved cards in its
> real pools. The guard is a check placed before the unchanged charge call,
> and its rule is unit-tested.
>
> **Scope limits of phase 4** (merchant stores):
> - one draw per draw date (no recurring cadence);
> - raffle lines in the CART are refused (enter from the product page);
> - no winner or waitlist emails;
> - a declined waitlist entry is marked declined, not retried.

> _Previous note (phase 3 + hardening):_
>
>
> **Header hardening: done and verified on production** (owner asked for it
> before phase 3). **Method:** an inventory of every request header the code
> reads, then a live probe of each client-settable one, before and after the
> fix.
>
> | Header | Before (proven on production) | Fix | After |
> |---|---|---|---|
> | `x-vercel-cron: 1` | ran `/api/analytics/social-tick` from curl (401 → 200). Also authorized both raffle DRAW routes and the recovery emails (not called) | no header is trusted; the secret is always required (the Cloudflare cron worker already sends it) | 401 on all four scheduler routes |
> | `x-forwarded-for` | rotating it never hit signup's 5/hour limit; plain requests got 429 on the 6th. Every limit was bypassable, admin login's included | `cf-connecting-ip` (Cloudflare refuses a client-sent one: 403) | spoofed requests share the real IP's bucket and get 429 |
> | `x-forwarded-host` (portal) | `shop./admin` + `admin.*` was routed as the admin portal (307 to its login) | `Host` only; `TRUST_FORWARDED_HOST=true` opts a trusted proxy back in | 404 |
> | `x-forwarded-host` (Stripe/email URLs) | not exploitable here: production handlers received the real host | one helper, `requestOrigin`, for all six builders | `success_url` stays `shop.goyunir.com` under spoofing |
> | `x-pathname` | no exploit found | the pre-config pass-through now sets it; a test fails if a dynamic route appears under `app/admin` | n/a |
>
> **Phase 3 (cart) is live and proven:** `scripts/verify-tenant-cart.ts`, a
> real bag on `test4.goyunir.com`, **all PASS**:
> - **The bag:** Pair Large ×1, Pair Small ×2, Item ×1 = 6700, paid on
>   test4's account only, three line items.
> - **The fee:** 134 on the cart total.
> - **The order:** ONE order, `TEST-1CDJ0N2`, all three lines linked to their
>   variants with the right quantities and prices, fee 134.
> - **Records:** one billing row; stock 10/10/8 → 9/8/7; nothing written for
>   the default store; the event was processed once.
> - **Merchant-side refunds:** partial 2400 → fee returned in proportion, 48;
>   the rest → the whole fee, 134; month volume back to where it started.
> - **Default store's cart:** still reaches Stripe on the platform account,
>   unchanged.
> - **Isolation, both directions:** clean.
>
> **Known limits** (true of the default store too, unless noted):
> - Stock is checked at checkout and decremented after payment. Two buyers can
>   pay for the last unit: the reservation-hold go-live blocker (STRATEGY §9).
> - If the webhook died between the stock decrement and marking the event
>   done, a reclaim (5 minutes later) would decrement again. The order and the
>   fee are idempotent; stock is not.
> - A refund does not restock.
> - The default store's cart route puts the whole cart in ONE metadata value
>   (a 500-character cap), so a large cart there can fail at session creation.
>   The tenant path splits it.
>
> **Not yet for a connected merchant** (refused, never mixed with the default
> store):
> - raffles and waitlists, and promo codes;
> - customer accounts and login;
> - release alerts;
> - order emails;
> - `/catalog` groupings;
> - per-store share card and icon;
> - the footer's Terms, Privacy, Shipping and "Manage My Entry" links. The
>   template shows them, but they 404 on merchant addresses (T10), so they are
>   dead links there.
>
> **Next:** phase 4 (raffle, draws, waitlist, with the saved-card cutover rule
> in CONNECT.md §4), then phase 5 (accounts, alerts, emails, legal pages).

> _Phase 2 evidence:_
>
> **Phase 2 is live and proven:** a connected merchant sells through its own
> Stripe account, from its own address.
>
> **Real checkouts through `test4.goyunir.com`** (`scripts/verify-tenant-checkout.ts`,
> Chrome at phone width), **all PASS:**
> - **The journey:** product page → size → email → address from the dropdown →
>   "SECURE PIECE · $19.00" → Stripe's hosted page (branded test4) → paid →
>   back on test4 with "Purchase complete".
> - **Stripe:**
>   - the session and PaymentIntent are on `acct_1UJWFxPIsRXBZjvC` only;
>   - `application_fee_amount` 38 = `platformFeeForCharge`;
>   - the platform received the fee.
> - **Database, written by the Connect webhook:**
>   - order `TEST-SSFCMX`: 1900 usd, `platform_fee_cents` 38, fcfs, paid;
>   - exactly one `tenant_billing_charges` row;
>   - stock 10 → 9;
>   - month volume 0 → 1900;
>   - nothing written for the default store;
>   - the event was processed once.
> - **Refund from the merchant side** (the refund call itself does not return
>   our fee): the webhook returned it exactly, 38 of 38 (D5), and the month
>   volume went back to 0.
> - **Dispute card:**
>   - order `TEST-MQE9F2` recorded as above;
>   - dispute `du_1UJqraPIsRXBZjvCPAQFC9kj` is on test4 only;
>   - the fee was kept (T11);
>   - the `charge.dispute.created` event was processed (tenant taken from the
>     PaymentIntent).
>
> **Also verified:**
> - **Connect webhook** `we_1UJqaJPIsR6ijfBZKhEtltNm` is registered
>   (owner-confirmed). `account.updated` → tenant re-synced
>   (`scripts/verify-connect-webhook.ts`).
> - **Isolation, both directions** (`scripts/verify-tenant-isolation.ts`): no
>   default-store product on any test4 page or response, and no test4 product
>   on any shop page.
> - **Default store:** the mobile buy journey still reaches Stripe at 375,
>   390 and 414 px.
>
> **The leak the owner spotted (fixed):** `/api/catalog/status` listed the
> default store's products on test4. It was one of about 20 public routes that
> read the default store's KV data without calling `ensureDefaultTenant()`,
> which is what phase 1's sweep searched for. Fixed structurally: **T10,
> default-deny at the edge on merchant addresses.**
>
> **Not yet for a connected merchant** (refused, never mixed with the default
> store):
> - cart checkout (`/api/checkout/cart`);
> - raffles and waitlists;
> - promo codes;
> - customer accounts and login;
> - release alerts;
> - catalog groupings on `/catalog` (the page is empty; product pages work);
> - per-store share card and icon;
> - order confirmation emails.
>
> A refund does not restock.
>
> **Next, in order:**
> 1. Cart for connected merchants (phase 3).
> 2. Raffle, draws, waitlist (phase 4, with the saved-card cutover rule).
> 3. Customer accounts, alerts, emails (phase 5).
> 4. **HARDENING, soon:** middleware portal classification trusts
>    `x-forwarded-host` (see below).

> _Earlier note (phase 1):_
>
> **Phase 1 is live and verified on production** (commits 62ef0bc, then the
> neutral-hero fix):
>
> | Check | Result |
> |---|---|
> | `shop.` / `www.` | the default store, unchanged: both products, the same hero |
> | `shop.` buy journey (mobile flows, 30 steps at 375, 390 and 414 px) | reaches Stripe checkout |
> | `test4.` | its own empty catalog, named "test4", neutral hero (no default-store copy) |
> | `test4.` checkout / cart / session routes | 409 "cannot take orders yet" |
> | `nosuchstore-xyz.` pages and API | 404; the legacy-host setting is live |
> | `media.` | 404 at `/`; product images still 200 |
> | `admin.` / `app.` | portals unchanged (307 to `/admin`) |
>
> **Also found:**
> - **HARDENING — DONE 2026-09-26** (see the top of this note). Was: the middleware's portal classification
>   (`resolveRequestHost` in `lib/edge-router.ts`) prefers `x-forwarded-host`,
>   which any client can set, so a request can claim to be for another portal
>   host. The admin role check still stops unauthorized access. The fix: use
>   `Host` only in production (keep the forwarded header for local proxies),
>   and test it. The tenancy resolver and the T10 edge check already use
>   `Host` only.
> - **Owner:** the template defaults carry the original store's brand copy
>   (hero text, "CALIFORNIA USA") in `goyunir.config.ts`,
>   `lib/storefront-config.ts` and `LegacyHomePage`. Other stores are shielded
>   by `withNeutralHero`. The defaults themselves are untouched because the
>   live store's saved config matches them.
> - **Owner:** stores with `license_status: 'expired'` get a 404. Nothing sets
>   it today.

## 1. The problem

The storefront has always served one store. Every storefront read and every
checkout gets its tenant from `ensureDefaultTenant()`: about 100 call sites in
36 files. A second merchant's customers can't reach their own catalog or
checkout at all.

What production does today:

- **DNS is a wildcard, and the worker claims `*.goyunir.com/*`.** So
  `test4.goyunir.com` and `nosuchstore-xyz.goyunir.com` both return 200 and
  serve the *default* store, working checkout included (checked 2026-09-25).
- **Our own subdomains:**
  - `www`, `api` and `shop` all serve the default store;
  - `app`, `admin` and `sales` are the portals;
  - `media` is the image host.
- **Signup already reserves** `shop`, `admin`, `www` and 14 other labels
  (a list local to the signup route). T4 replaces it with one shared rule that
  also covers the legacy-host setting, so the list and the resolver can't
  drift.
- **Tenant-scoped today:**
  - the Postgres catalog (`readProductsFromPostgres(tenantId)`);
  - per-tenant store config;
  - orders;
  - inventory levels;
  - billing;
  - Connect.
- **Global today, in KV** (the `store_kv` table has one namespace):
  - raffle entries (`entries:*`);
  - the sales ledger (`ARCHIVE_LEDGER_KEY`), which is also the per-email
    purchase cap;
  - live-state mirrors;
  - promo codes;
  - the KV catalog fallback;
  - store config;
  - analytics.

  Two stores would read and write each other's.

## 2. Decisions

Each is the conservative choice. The ones marked **(owner)** can be changed.

| # | Decision | Why |
|---|---|---|
| T1 | A merchant's address is **`<slug>.<PLATFORM_ROOT_DOMAIN>`**, plus their own custom domain once Cloudflare reports it `active` (00010). | Wildcard DNS and the worker route already exist, so no DNS work is needed. |
| T2 | **The default (legacy) store's hosts are listed, never inferred:** the `STOREFRONT_LEGACY_HOSTS` setting (comma-separated; today `shop`, `www`, `api` under the root). Hosts are checked **before** any slug, so no signup can claim them. **(owner)** which hosts stay. | Nothing hardcoded, and no slug can take over a live address. |
| T3 | **An unknown subdomain is a 404**, not the default store. | Today a typo shows your store and lets someone buy from it. A request meant for store X must never be served or charged as store Y. |
| T4 | **Reserved labels can't be slugs:** the portal and system labels (`admin`, `app`, `sales`, `www`, `api`, `media`, `mail`, `shop`, `default`, …), plus every label in T2. Enforced at signup. Existing slugs are checked (none collide today). | Same reason as T2. |
| T5 | **The tenant is resolved from the `Host` header on the server**, with a short per-isolate cache. It is never taken from a client-supplied header, query or body. | A client could otherwise pick whose store it is buying from. |
| T6 | **With no root domain configured** (single-domain deployments, local dev), every host is the default store. | Behaviour for such deployments stays exactly as today. |
| T7 | **A non-default tenant never touches global KV keys.** Its KV state lives under a tenant prefix; the default tenant's keys are unchanged, so no data migration. | Isolation without risking the live store's data. |
| T8 | **A non-default tenant never falls back to the KV catalog.** Postgres or nothing. | The fallback *is* the default store's catalog. |
| T10 | **Default-deny at the edge on a merchant address.** Middleware serves a slug or custom-domain host only the paths proven tenant-aware (`merchantHostAllowsPath`: `/`, `/catalog`, product pages, `/api/store`, `/api/catalog/status`); every other page and API is a 404. A path is added only once it resolves its tenant. | Phase 1 guarded routes one by one and missed `/api/catalog/status`, which listed the default store's products on test4 (owner spotted it, 2026-09-26). Enumerating the routes that must be closed fails open; this fails closed, including for routes added later. |
| T11 | **Disputes: the platform keeps its fee** (owner decision, 2026-09-26). On a lost dispute the application fee is NOT returned to the merchant. This is explicit, not a default: it matches Stripe (which doesn't return platform fees on disputes), and the merchant made the sale and carries the dispute outcome under the liability model (`losses_collector: stripe`, direct charges). Refunds still return the fee exactly (D5). Proven: dispute `du_1UJXVcPIsRXBZjvCeTnzUoBs`, fee 38 kept, refunded 0. | Owner decision. |
| T9 | **A non-default tenant sells only through its own connected account** (routing rule, CONNECT.md §3). No account, or onboarding not finished, means checkout is refused. | Already the rule; stated here so no phase forgets it. |

## 3. Resolution order (pure function, `lib/storefront-tenant.ts`)

1. No root domain configured → **default** (T6).
2. Host is the root itself → **marketing**. Not a store.
3. Host is in `STOREFRONT_LEGACY_HOSTS` → **default** (T2).
4. Host is `<label>.<root>`:
   - `admin`, `app` or `sales` → **portal**. Not a store.
   - any other reserved label → **not found**;
   - a tenant with that slug → **that tenant**;
   - otherwise → **not found** (T3).
5. Anything else (outside the root): a tenant whose `custom_domain` is that
   host and `active` → **that tenant**. Otherwise, `localhost`/`127.0.0.1` →
   **default**. Otherwise → **not found**.

## 4. What changes, by surface

- **Read path:** `/api/store`, the home/product/catalog pages, and the
  `/api/store` prefetch. The tenant comes from the host, and the catalog from
  that tenant's Postgres rows.
- **Checkout, direct:** the tenant from the host; the charge routed by
  `chargeRouteForTenant`; for a connected tenant, a direct charge on their
  account with `application_fee_amount` from `platformFeeForCharge`. Then the
  order row, then `recordBillingCharge`. The per-email cap and the ledger are
  tenant-scoped.
- **Checkout, cart:** the Session on the merchant's account. Its
  `checkout.session.completed` arrives at the **Connect** endpoint, so this
  path waits for that endpoint's registration (owner confirmation,
  CONNECT.md).
- **Raffle entry, draws, waitlist, trigger-drop:** tenant-scoped entries, and
  cards saved on the merchant's account. Last, with the cutover rule in
  CONNECT.md §4.
- **Customer accounts, auth, rewards, analytics:** per tenant. Accounts are the
  largest piece: today a customer account is global.
- **Admin / merchant app:** already acts on `resolveActingTenantId`
  (impersonation). A merchant's own login acting on their own tenant is a
  separate piece of work.

## 5. Phases (each verified live before the next)

1. **Resolver + reserved slugs + read path.**
   - Built: the pure resolver with tests, `STOREFRONT_LEGACY_HOSTS`, signup
     rejecting reserved slugs, and `/api/store` plus the pages serving the
     host's tenant.
   - Verify:
     - `shop.goyunir.com` is unchanged: the mobile flows still reach Stripe;
     - `test4.goyunir.com` serves test4's own (empty) catalog;
     - `nosuchstore-xyz.goyunir.com` returns 404;
     - `admin.` and `app.` are unchanged.
2. **Direct checkout for a connected tenant.** A real charge through
   `test4.goyunir.com`. Expect it on test4's account, fee =
   `platformFeeForCharge`, an order row with the fee, and exactly one
   `tenant_billing_charges` row. Plus the refund and dispute checks from
   CONNECT.md §7 through the real route.
3. **Cart**, after the Connect endpoint is registered.
4. **Raffle, draws, waitlist, trigger-drop.**
5. **Customer accounts, rewards, analytics.**

The default store must keep working through every phase: the mobile flows
and a real test checkout on `shop.` after each deploy.
