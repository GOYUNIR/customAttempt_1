# EVIDENCE — proof logs and detailed go-live history

Not auto-imported (CLAUDE.md loads only AGENTS.md and STRATEGY.md). Read this
when debugging stock/reservations, Connect, or anything a go-live item below
refers to. STRATEGY.md §9 keeps only the short done/pending list.

## Go-live checklist as of 2026-09-27, with its evidence (moved from STRATEGY.md §9)

Real customer transactions must not be possible until **every** item below is
true. The trigger is the moment real traffic *becomes possible*, not a calendar
date. Each item is here because it has already failed or been shown to be
missing. Add to this list whenever such a gap is found. Tick an item only with
evidence, and write the evidence next to it.

### Hard blockers — without these it is not a usable or safe store

- [ ] **🛑 A MERCHANT CAN SET STOCK. Today they cannot.** A merchant who can't
  restock, or can't mark something sold out, is not running a store. That
  makes this a hard blocker, not a polish item (owner, 2026-09-24).
  - For any variant that already has an `inventory_levels` row, the product
    editor's per-size inventory field is saved into config and then ignored:
    `catalog-write` only creates missing rows.
  - `/api/admin/inventory` writes only the KV mirror, and no UI calls it.
  - `inventory-matrix` is read-only.
  - Production logs show it happening: "configured inventory 15 differs from
    live stock 1."
  - A merchant can't restock, and can't set a product to 0 to pull it from
    sale.
  - The fix is an explicit stock-set / stock-adjust operation that is safe
    against in-flight sales. **Design it together with reservation holds, in
    one pass.** Both need stock changes recorded as movements rather than
    overwritten numbers, and two separate patches would disagree with each
    other.
- [ ] **🛑 Inventory reservation holds.** The cart path checks stock when the
  Stripe session is created and decrements only after payment, so two buyers
  can both pay for the last unit. §4 requires a real hold. Same design pass as
  the item above.
  - **Design approved (owner, 2026-09-27).** Holds plus an append-only
    movement ledger, each change one atomic Postgres function (migration
    00037, `lib/stock.ts`).
    - Holds last 30 minutes (the Stripe session is 31 minutes, the hold 36).
    - A payment that lands after its hold lapsed is recorded: stock stops at
      0 and the merchant sees "oversold by N". No automatic refund.
    - The storefront shows sold out while units are held.
    - The original store is included (as the last step).
  - **Rollout, each step proven live before the next:**
    1. migration + race proof;
    2. merchant stock tools;
    3. merchant checkout and cart;
    4. raffles and waitlist;
    5. the original store.
  - **Status: all five steps are live and proven on production
    (2026-09-27).**
    - **Evidence:**
      - `tests/stock-sql.test.ts` 13/13 (real Postgres);
      - `scripts/verify-stock-race.ts` 13/13 (12 concurrent buyers on 5
        units, then 5 exactly; recount racing sales, with the movement chain
        re-derived independently);
      - `scripts/verify-merchant-isolation.ts` 89/89 (stock tools included);
      - `scripts/verify-merchant-dashboard-ui.ts` 25/25;
      - `scripts/verify-stock-checkout.ts` ALL PASS (merchant: last unit,
        second buyer refused, expiry release, recount during open checkout,
        cart all-or-nothing);
      - `scripts/verify-tenant-drops.ts` enter + draw ALL PASS (winner and
        waitlist holds);
      - `scripts/verify-stock-original.ts` ALL PASS (original store: single,
        cart, direct, expiry; real products byte-identical).
    - **Structural guard:** `tests/stock-writes.test.ts` fails if runtime code
      writes inventory_levels outside the ledger.
    - **Still open for the stock blocker above:** the ORIGINAL store's /admin
      has no stock tool yet. Merchants have one in /app; the original store's
      admin inventory screens still write the KV mirror only.
    - **At go-live:** the LIVE-mode Stripe webhook endpoints (platform and
      Connect) must subscribe to `checkout.session.expired`, as the test-mode
      ones now do. Without it, holds still lapse, just 36 minutes later
      instead of at session expiry.
- [ ] **🛑 Stripe Connect.** Each merchant sells through their own connected
  account (Accounts v2 with direct charges), with the platform fee collected as
  an application fee. Today every tenant shares one Stripe account, so a second
  merchant's customers would be paying the platform. Connect is what makes
  multi-merchant selling legal. Design: `CONNECT.md`.
  - Connect and Accounts v2 are enabled (verified through the API on
    2026-09-25). The first test connected account exists.
  - **Per-merchant storefronts** (TENANCY.md): phases 1–2 are live. A
    connected merchant's single-product hosted checkout is proven end to end
    through `test4.goyunir.com` (2026-09-26): the fee, the order, billing,
    refund and dispute.
  - **Still to do:** the cart, raffle/waitlist, customer accounts and emails
    for connected merchants. They are refused on merchant addresses until
    built.
- [ ] **🛑 Cloudflare Workers Paid.** On Free the ceiling is 50 subrequests per
  invocation. **Also hit by merchant raffle draws**
  (2026-09-26). On Free a draw completes about one charge per trigger, and the
  first live draw exhausted the budget mid-write before the engine was made
  budget-aware. At the upgrade, set . The checkout webhook measured 51 on a one-item cart before B
  (2026-09-24). Staying on Free until go-live is deliberate (owner). Upgrading
  is the first go-live action.

- [ ] **🛑 A merchant can run their OWN store from the merchant app.** Found
  2026-09-26: the whole admin tree acts on the original store and authorized
  any valid admin session, so a merchant owner could read and write the
  original store. Proven read-only on production, then **contained**: sessions
  for another store now get 403 on /admin and /api/admin
  (`lib/default-tenant.ts`, `scripts/verify-admin-tenant-guard.ts`). That
  leaves a merchant with no dashboard at all: they can't manage their catalog,
  prices, stock, orders, branding or Connect onboarding. Public merchant
  signup is still open (`ALLOW_MERCHANT_SIGNUP=true`), so a new signup lands
  on "dashboard not available". Closing signup until the dashboard exists is
  an owner decision.

### Must also be true

- [ ] **Every charge path writes an order**, proven by a real charge on each
  path.
  - Proven with real test-mode charges: direct checkout, cart (the webhook), and
    the auto-draw winner charge.
  - Not yet proven with a real charge: admin trigger-drop, and waitlist
    conversion.
- [x] **No shared-inventory pool can be sold through a path that ignores it.**
  Postgres stock is per-variant and ignores `shared_pool_id`, so every stock
  gate refuses a pooled variant (`lib/stock-gate.ts`, B1). Evidence: unit tests
  in `tests/stock-gate.test.ts`. Not exercised live, because no production
  variant uses a pool. Real pool support is a separate feature.
- [ ] **The homepage copy doesn't contradict the fee model** (DEFERRED-9).
